// =============================================================================
// jobs/execute.ts — the §9 job bodies, with their dependencies injected.
//
// The registry (jobs/index.ts) says WHICH jobs exist; this module says what
// they DO. The cron route owns authentication and the 404/501 semantics, then
// hands a job name to `executeJob` with a `JobContext` already built from the
// process-wide client and settings reader. Nothing here imports Prisma or
// `process.env`, so the SQL these jobs emit is assertable in a unit test the
// same way lib/network.ts is (tests/cycle-jobs.test.ts).
//
// IDEMPOTENCY IS THE DESIGN, NOT A RETRY POLICY (D41)
// ---------------------------------------------------
// §9 asks for idempotent jobs and names `pg_try_advisory_lock`. The two guard-
// only jobs (`cycle:ensure`, `cycle:obligations`) stay idempotent by
// construction: `cycle:ensure` inserts a window only when its period key is
// absent and no existing window overlaps it (NOT EXISTS guard, with ON CONFLICT
// as the race-safe backstop and SQLSTATE 23P01 treated as "someone else won"),
// and `cycle:obligations` inserts with ON CONFLICT DO NOTHING against
// `uq_obligations_cycle_user`. Running either job twice is a no-op, so they run
// in autocommit — and that is deliberate: a caught 23P01 inside an open
// transaction would leave it aborted (SQLSTATE 25P02), so locking them would
// break the very race tolerance that makes them safe.
//
// The multi-statement jobs are read-decide-write and DO take the lock (D41):
// `executeJob` runs every name in LOCKED_JOBS inside one interactive
// transaction whose first statement is `pg_try_advisory_xact_lock` — a second
// concurrent run sees the lock held and answers a skip instead of duplicating.
// =============================================================================

import {
  daysBetweenLocalDates,
  localDateKey,
  planCycles,
  type CycleFrequency,
} from "../lib/cycles";
import { formatAmount, parseAmount } from "../lib/money";
import type { SettingsReader } from "../lib/settings";

/** The narrower surface a transaction callback receives (D57 pattern). */
export interface JobTx {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface JobDb extends JobTx {
  /**
   * Interactive transaction: the advisory lock and every statement of a
   * multi-statement job share one pinned session, so the lock is held exactly
   * as long as the job runs and released on commit/rollback.
   */
  $transaction<T>(fn: (tx: JobTx) => Promise<T>): Promise<T>;
}

export type JobSettings = Pick<SettingsReader, "getOrThrow">;

export interface JobContext {
  db: JobDb;
  settings: JobSettings;
  /** Injected so a run is reproducible under test; the route passes new Date(). */
  now: Date;
}

/** What a runner receives: the context with its transaction-scoped client. */
export type JobRunContext = Omit<JobContext, "db"> & { db: JobTx };

export type JobSummary = Record<string, unknown>;
export type JobRunner = (ctx: JobRunContext) => Promise<JobSummary>;

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
async function cycleEnsure({ db, settings, now }: JobRunContext): Promise<JobSummary> {
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
async function cycleObligations({ db, settings, now }: JobRunContext): Promise<JobSummary> {
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

interface ReminderCycleRow {
  id: string;
  periodKey: string;
  dueAt: Date;
}

/**
 * True when the local date of `dueAt` sits exactly N local days after the
 * local date of `now`, for some N in `daysBefore` (§9: reminders fire "según
 * payments.reminder_days_before_due"). Both calendar dates are resolved in
 * `timezone`, never UTC and never the browser's (R11), so the answer flips
 * correctly around midnight.
 */
export function matchesReminderDay(
  now: Date,
  dueAt: Date,
  timezone: string,
  daysBefore: readonly number[],
): boolean {
  const distance = daysBetweenLocalDates(
    localDateKey(now, timezone),
    localDateKey(dueAt, timezone),
  );
  return daysBefore.includes(distance);
}

/**
 * `cycle:reminders` — notifies, in-app (D59), every ACTIVE user who has not
 * reported on a cycle whose `due_at` is exactly N local days away (§9).
 *
 * Idempotency is twofold: the audience excludes anyone with a non-REJECTED
 * report (a rejected report is history — D43 — so its author is reminded
 * again), and the INSERT refuses a second `cycle.reminder` for the same
 * (user, cycle, local day), so re-running the job the same day inserts
 * nothing. The advisory lock (LOCKED_JOBS) serializes concurrent runs on top.
 */
async function cycleReminders({ db, settings, now }: JobRunContext): Promise<JobSummary> {
  const [timezone, reminderDays] = await Promise.all([
    settings.getOrThrow<string>("general.timezone"),
    settings.getOrThrow<number[]>("payments.reminder_days_before_due"),
  ]);

  // A mis-typed setting must not silence the job silently; only integer day
  // offsets are meaningful, and a non-array value means "no reminder days".
  const daysBefore = Array.isArray(reminderDays) ? reminderDays.filter(Number.isInteger) : [];

  // Candidates: open cycles whose due date is still ahead and that still have
  // someone pending. Closed cycles are cycle:close's concern.
  const cycles = await db.$queryRaw<ReminderCycleRow[]>`
    /* @job:reminder-cycles */
    SELECT id, period_key AS "periodKey", due_at AS "dueAt"
    FROM payment_cycles
    WHERE status <> 'CLOSED'
      AND due_at > ${now}::timestamptz
      AND EXISTS (
        SELECT 1
        FROM cycle_obligations o
        WHERE o.cycle_id = payment_cycles.id
          AND o.status = 'PENDING'
      )
    ORDER BY starts_at
  `;

  const todayKey = localDateKey(now, timezone);
  const matching = cycles.filter((cycle) =>
    matchesReminderDay(now, cycle.dueAt, timezone, daysBefore),
  );

  let notified = 0;
  for (const cycle of matching) {
    notified += await db.$executeRaw`
      /* @job:reminder-insert */
      INSERT INTO notifications (user_id, type, title, body, data)
      SELECT
        o.user_id,
        'cycle.reminder',
        ${"Aporte pendiente"},
        ${`No registramos tu aporte de la semana ${cycle.periodKey}. Envíalo antes del vencimiento para mantener tu cumplimiento.`},
        jsonb_build_object('cycleId', ${cycle.id}, 'periodKey', ${cycle.periodKey})
      FROM cycle_obligations o
      JOIN users u ON u.id = o.user_id
      WHERE o.cycle_id = ${cycle.id}::uuid
        AND o.status = 'PENDING'
        AND u.deleted_at IS NULL
        AND u.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1
          FROM payment_reports pr
          WHERE pr.user_id = o.user_id
            AND pr.cycle_id = o.cycle_id
            AND pr.status <> 'REJECTED'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM notifications n
          WHERE n.user_id = o.user_id
            AND n.type = 'cycle.reminder'
            AND n.data->>'cycleId' = ${cycle.id}
            AND (n.created_at AT TIME ZONE ${timezone})::date = ${todayKey}::date
        )
    `;
  }

  return {
    candidates: cycles.length,
    cycles: matching.length,
    notified,
    reminderDays: daysBefore,
  };
}

/** Job name -> runner. Only names listed in jobs/index.ts with implemented: true. */
const RUNNERS: Record<string, JobRunner> = {
  "cycle:ensure": cycleEnsure,
  "cycle:obligations": cycleObligations,
  "cycle:reminders": cycleReminders,
};

/**
 * Jobs whose body is a read-decide-write critical section (D41 defers §9's
 * advisory lock to exactly these): two concurrent `cycle:reminders` runs could
 * both read "no report yet" and both insert a notification. The guard-only
 * jobs stay out — see the header: a caught 23P01 poisons an open transaction,
 * and their race tolerance depends on autocommit.
 */
const LOCKED_JOBS = new Set(["cycle:reminders"]);

/**
 * Run one implemented job. The route checks the registry before calling, so a
 * name with no runner is registry drift — a programming error, not a client
 * error, hence the throw.
 *
 * Locked jobs run inside one interactive transaction: the transaction-scoped
 * advisory lock (`pg_try_advisory_xact_lock`, released on commit/rollback)
 * serializes concurrent runs of the same job, and a run that finds the lock
 * held skips instead of racing. The hashtext key namespaces by job, so two
 * different jobs never block each other.
 */
export async function executeJob(name: string, context: JobContext): Promise<JobSummary> {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`No runner registered for job "${name}"`);

  if (!LOCKED_JOBS.has(name)) return runner(context);

  return context.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      /* @job:lock */
      SELECT pg_try_advisory_xact_lock(hashtext(${`job:${name}`})) AS locked
    `;
    if (rows[0]?.locked !== true) return { skipped: true, reason: "LOCK_BUSY" };
    return runner({ ...context, db: tx });
  });
}
