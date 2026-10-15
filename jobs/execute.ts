// =============================================================================
// jobs/execute.ts — the §9 job bodies, with their dependencies injected.
//
// The registry (jobs/index.ts) says WHICH jobs exist; this module says what two
// of them DO. The cron route owns authentication and the 404/501 semantics,
// then hands a job name to `executeJob` with a `JobContext` already built from
// the process-wide client and settings reader. Nothing here imports Prisma or
// `process.env`, so the SQL these jobs emit is assertable in a unit test the
// same way lib/network.ts is (tests/cycle-jobs.test.ts).
//
// IDEMPOTENCY IS THE DESIGN, NOT A RETRY POLICY (D41)
// ---------------------------------------------------
// §9 asks for idempotent jobs and names `pg_try_advisory_lock`. A session
// advisory lock needs a pinned connection (an interactive `$transaction`) that
// a pooled Prisma client only guarantees from inside the callback, and for
// these two jobs it adds no correctness: `cycle:ensure` inserts a window only
// when its period key is absent and no existing window overlaps it (NOT EXISTS
// guard, with ON CONFLICT as the race-safe backstop and SQLSTATE 23P01 treated
// as "someone else won"), and `cycle:obligations` inserts with ON CONFLICT DO
// NOTHING against `uq_obligations_cycle_user`. Running either job twice is a
// no-op, so the advisory lock is deferred to F7's multi-statement jobs
// (close/reminders), where a critical section actually matters.
// =============================================================================

import { planCycles, type CycleFrequency } from "../lib/cycles";
import { formatAmount, parseAmount } from "../lib/money";
import type { SettingsReader } from "../lib/settings";

/** The raw slice of Prisma the jobs use; `$executeRaw` returns the affected count. */
export interface JobDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export type JobSettings = Pick<SettingsReader, "getOrThrow">;

export interface JobContext {
  db: JobDb;
  settings: JobSettings;
  /** Injected so a run is reproducible under test; the route passes new Date(). */
  now: Date;
}

export type JobSummary = Record<string, unknown>;
export type JobRunner = (ctx: JobContext) => Promise<JobSummary>;

/**
 * PostgreSQL `exclusion_violation` (SQLSTATE 23P01).
 *
 * Prisma wraps a failed raw query in its own error and carries the SQLSTATE in
 * `meta.code`; a driver-level failure carries it as `code`. Both shapes are
 * read because which one surfaces depends on the Prisma/driver version, and
 * the cost of missing one is a job that crashes on a race it can shrug off.
 */
export function isExclusionViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: { code?: unknown } };
  return code === "23P01" || meta?.code === "23P01";
}

/** Windows kept materialized: the one containing `now` plus the next four (§9). */
const CYCLES_AHEAD = 5;

/**
 * `cycle:ensure` — guarantees the cycle containing `now` exists and creates
 * the next four (§9).
 */
async function cycleEnsure({ db, settings, now }: JobContext): Promise<JobSummary> {
  const [timezone, weekStartDay, graceHours, frequency] = await Promise.all([
    settings.getOrThrow<string>("general.timezone"),
    settings.getOrThrow<number>("payments.week_start_day"),
    settings.getOrThrow<number>("payments.grace_hours"),
    settings.getOrThrow<CycleFrequency>("payments.frequency"),
  ]);

  const windows = planCycles({ now, timezone, weekStartDay, graceHours, frequency }, CYCLES_AHEAD);

  let created = 0;
  let skipped = 0;
  let raced = 0;

  for (const window of windows) {
    try {
      // The NOT EXISTS guard covers restarts and changed settings (somebody
      // edited week_start_day while cycles already existed); ON CONFLICT
      // covers the concurrent insert the guard cannot see. Either way, a
      // second run inserts nothing.
      const inserted = await db.$executeRaw`
        /* @job:cycle-insert */
        INSERT INTO payment_cycles (period_key, starts_at, ends_at, due_at)
        SELECT
          ${window.periodKey}::text,
          ${window.startsAt}::timestamptz,
          ${window.endsAt}::timestamptz,
          ${window.dueAt}::timestamptz
        WHERE NOT EXISTS (
          SELECT 1
          FROM payment_cycles c
          WHERE c.period_key = ${window.periodKey}
             OR tstzrange(c.starts_at, c.ends_at) && tstzrange(${window.startsAt}::timestamptz, ${window.endsAt}::timestamptz)
        )
        ON CONFLICT (period_key) DO NOTHING
      `;
      if (inserted > 0) created += 1;
      else skipped += 1;
    } catch (error) {
      // The `no_overlap_cycles` EXCLUDE constraint firing means a concurrent
      // run (or a settings change between the guard and the insert) beat us
      // to it: losing that race is a skip, not a failure.
      if (!isExclusionViolation(error)) throw error;
      raced += 1;
    }
  }

  return {
    planned: windows.length,
    created,
    skipped,
    raced,
    periodKeys: windows.map((window) => window.periodKey),
  };
}

interface CycleRow {
  id: string;
  periodKey: string;
}

/**
 * `cycle:obligations` — seeds a PENDING obligation per ACTIVE user on every
 * cycle that has not ended yet (§9, §5.5).
 */
async function cycleObligations({ db, settings, now }: JobContext): Promise<JobSummary> {
  const [expectedAmountSetting, exemptRoot] = await Promise.all([
    settings.getOrThrow<number>("payments.expected_amount"),
    settings.getOrThrow<boolean>("payments.exempt_root"),
  ]);

  // NUMERIC(14,2) is written from the DECIMAL-string side of lib/money.ts: a
  // JS float must never reach the column (A14).
  const expectedAmount = formatAmount(parseAmount(expectedAmountSetting));

  // Only cycles that have not ended yet: a window past its grace is closed,
  // and its unfulfilled obligations are F7's `cycle:close` concern.
  const cycles = await db.$queryRaw<CycleRow[]>`
    /* @job:obligation-cycles */
    SELECT id, period_key AS "periodKey"
    FROM payment_cycles
    WHERE ends_at > ${now}::timestamptz
    ORDER BY starts_at
  `;

  let inserted = 0;
  for (const cycle of cycles) {
    inserted += await db.$executeRaw`
      /* @job:obligation-insert */
      INSERT INTO cycle_obligations (cycle_id, user_id, expected_amount)
      SELECT ${cycle.id}::uuid, u.id, ${expectedAmount}::numeric(14,2)
      FROM users u
      WHERE u.deleted_at IS NULL
        AND u.status = 'ACTIVE'
        AND (${exemptRoot}::boolean = FALSE OR u.role <> 'ROOT')
      ON CONFLICT (cycle_id, user_id) DO NOTHING
    `;
  }

  return { cycles: cycles.length, inserted, expectedAmount, exemptRoot };
}

/** Job name -> runner. Only names listed in jobs/index.ts with implemented: true. */
const RUNNERS: Record<string, JobRunner> = {
  "cycle:ensure": cycleEnsure,
  "cycle:obligations": cycleObligations,
};

/**
 * Run one implemented job. The route checks the registry before calling, so a
 * name with no runner is registry drift — a programming error, not a client
 * error, hence the throw.
 */
export async function executeJob(name: string, context: JobContext): Promise<JobSummary> {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`No runner registered for job "${name}"`);
  return runner(context);
}
