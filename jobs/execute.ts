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
import type { TreeDivergence } from "../lib/tree";

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

interface CloseCycleRow {
  id: string;
  periodKey: string;
  dueAt: Date;
}

/**
 * `cycle:close` — past `due_at`, obligations with no approved report become
 * MISSED and the cycle becomes CLOSED (§9). Strikes are DERIVED, not a counter
 * (D60): the suspension check counts the user's MISSED obligations, and a late
 * approval flips the obligation back to FULFILLED (lib/payments.ts), which
 * clears the strike by itself.
 *
 * The auto-suspension only touches users this run just marked MISSED: the spec
 * ties it to closing a cycle, and evaluating every ACTIVE user on every run
 * would fight a manual reactivation forever. Every write is idempotent by its
 * guard (`status = 'PENDING'`, `status = 'ACTIVE'`), so a retry after a crash
 * between statements resumes cleanly. The root is never auto-suspended: losing
 * the control account to a job would lock the instance out of its own admin.
 */
async function cycleClose({ db, settings, now }: JobRunContext): Promise<JobSummary> {
  const [autoSuspend, threshold] = await Promise.all([
    settings.getOrThrow<boolean>("payments.auto_suspend_on_strikes"),
    settings.getOrThrow<number>("payments.missed_grace_strikes"),
  ]);

  // §9: "Si now() > due_at". A window past its grace closes exactly once.
  const cycles = await db.$queryRaw<CloseCycleRow[]>`
    /* @job:close-cycles */
    SELECT id, period_key AS "periodKey", due_at AS "dueAt"
    FROM payment_cycles
    WHERE status <> 'CLOSED'
      AND due_at < ${now}::timestamptz
    ORDER BY starts_at
  `;

  let missed = 0;
  for (const cycle of cycles) {
    // "obligaciones sin reporte aprobado": fulfillment only happens when the
    // review approves the report, so at close time anything still PENDING is
    // a miss. MISSED rows already marked are left alone (retry-safe).
    missed += await db.$executeRaw`
      /* @job:close-missed */
      UPDATE cycle_obligations
      SET status = 'MISSED'
      WHERE cycle_id = ${cycle.id}::uuid AND status = 'PENDING'
    `;
    await db.$executeRaw`
      /* @job:close-cycle */
      UPDATE payment_cycles
      SET status = 'CLOSED'
      WHERE id = ${cycle.id}::uuid AND status <> 'CLOSED'
    `;
  }

  let suspended = 0;
  if (autoSuspend && cycles.length > 0) {
    const closedIds = cycles.map((cycle) => cycle.id);
    const suspendedUsers = await db.$queryRaw<Array<{ id: string; missedCount: number }>>`
      /* @job:close-suspend */
      UPDATE users u
      SET status = 'SUSPENDED'
      WHERE u.status = 'ACTIVE'
        AND u.role <> 'ROOT'
        AND u.deleted_at IS NULL
        AND u.id IN (
          SELECT o.user_id
          FROM cycle_obligations o
          WHERE o.cycle_id = ANY(${closedIds}::uuid[])
            AND o.status = 'MISSED'
        )
        AND (
          SELECT COUNT(*)
          FROM cycle_obligations counted
          WHERE counted.user_id = u.id AND counted.status = 'MISSED'
        ) >= ${threshold}
      RETURNING u.id AS id, (
        SELECT COUNT(*)::int
        FROM cycle_obligations o2
        WHERE o2.user_id = u.id AND o2.status = 'MISSED'
      ) AS "missedCount"
    `;

    for (const user of suspendedUsers) {
      await db.$executeRaw`
        /* @job:close-notify */
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES (
          ${user.id}::uuid,
          'user.suspended',
          ${"Cuenta suspendida"},
          ${"No completaste tus aportes de varias semanas y tu cuenta quedó suspendida. Contacta a la administración para reactivarla."},
          jsonb_build_object('reason', 'missed_grace_strikes', 'missedCount', ${user.missedCount})
        )
      `;
      await db.$executeRaw`
        /* @job:close-audit */
        INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
        VALUES (
          NULL,
          'user.auto_suspend',
          'users',
          ${user.id},
          ${JSON.stringify({ status: "ACTIVE" })}::jsonb,
          ${JSON.stringify({ status: "SUSPENDED", missedCount: user.missedCount, threshold })}::jsonb
        )
      `;
    }
    suspended = suspendedUsers.length;
  }

  return { cycles: cycles.length, missed, suspended, autoSuspend, threshold };
}

/**
 * Divergences between the three redundant structures of the referral tree
 * (§9 `tree:verify`, A11/A13): `users.path`/`users.depth` and `user_closure`
 * versus a recursive walk over the canonical `sponsor_id` pointers.
 *
 * One round trip computes everything: the down-walk is the ground truth, the
 * expected closure edges are every ancestor chain of every user (self rows
 * included), and a user is divergent when it is unreachable from the root, or
 * its depth/path disagree with the walk, or its closure rows are missing,
 * stale or carry a wrong depth.
 */
function findTreeDivergences(db: JobTx): Promise<TreeDivergence[]> {
  return db.$queryRaw<TreeDivergence[]>`
    /* @job:tree-problems */
    WITH RECURSIVE walk AS (
      SELECT
        u.id AS user_id,
        ARRAY[u.id::text] AS chain,
        'root'::text AS expected_path,
        0 AS expected_depth
      FROM users u
      WHERE u.sponsor_id IS NULL
      UNION ALL
      SELECT
        c.id,
        w.chain || c.id::text,
        w.expected_path || '.' || fn_ltree_label(c.public_code),
        w.expected_depth + 1
      FROM users c
      JOIN walk w ON c.sponsor_id = w.user_id
    ),
    expected AS (
      SELECT
        w.user_id,
        w.expected_depth,
        w.expected_path,
        (w.chain[g])::uuid AS ancestor_id,
        w.expected_depth + 1 - g AS depth
      FROM walk w
      CROSS JOIN LATERAL generate_series(1, w.expected_depth + 1) AS g
    ),
    missing_edges AS (
      SELECT e.user_id, count(*) AS total
      FROM expected e
      LEFT JOIN user_closure cl
        ON cl.ancestor_id = e.ancestor_id AND cl.descendant_id = e.user_id
      WHERE cl.ancestor_id IS NULL
      GROUP BY e.user_id
    ),
    stale_edges AS (
      SELECT cl.descendant_id AS user_id, count(*) AS total
      FROM user_closure cl
      LEFT JOIN expected e
        ON e.user_id = cl.descendant_id AND e.ancestor_id = cl.ancestor_id
      WHERE e.user_id IS NULL
      GROUP BY cl.descendant_id
    ),
    wrong_depth AS (
      SELECT e.user_id, count(*) AS total
      FROM expected e
      JOIN user_closure cl
        ON cl.ancestor_id = e.ancestor_id AND cl.descendant_id = e.user_id
      WHERE cl.depth <> e.depth
      GROUP BY e.user_id
    )
    SELECT
      u.id AS "userId",
      u.public_code AS "publicCode",
      concat_ws('; ',
        CASE WHEN w.user_id IS NULL
          THEN 'not reachable from the root via sponsor_id' END,
        CASE WHEN w.user_id IS NOT NULL AND u.depth <> w.expected_depth
          THEN 'users.depth ' || u.depth || ' <> expected ' || w.expected_depth END,
        CASE WHEN w.user_id IS NOT NULL AND u.path::text <> w.expected_path
          THEN 'users.path ' || u.path::text || ' <> expected ' || w.expected_path END,
        CASE WHEN m.user_id IS NOT NULL
          THEN m.total || ' closure edge(s) missing' END,
        CASE WHEN s.user_id IS NOT NULL
          THEN s.total || ' closure edge(s) stale' END,
        CASE WHEN d.user_id IS NOT NULL
          THEN d.total || ' closure edge(s) with wrong depth' END
      ) AS reason
    FROM users u
    LEFT JOIN walk w          ON w.user_id = u.id
    LEFT JOIN missing_edges m ON m.user_id = u.id
    LEFT JOIN stale_edges s   ON s.user_id = u.id
    LEFT JOIN wrong_depth d   ON d.user_id = u.id
    WHERE w.user_id IS NULL
       OR u.depth <> w.expected_depth
       OR u.path::text <> w.expected_path
       OR m.user_id IS NOT NULL
       OR s.user_id IS NOT NULL
       OR d.user_id IS NOT NULL
    ORDER BY u.created_at
  `;
}

/** Divergences embedded in the audit row: enough to triage, bounded in size. */
const AUDIT_PROBLEMS_CAP = 50;

/**
 * `tree:verify` — compares `user_closure`/`path` against the recursion over
 * `sponsor_id`; on divergence, records the alert (audit + staff notification)
 * and rebuilds via `fn_tree_rebuild()` (migration 0004), then re-verifies
 * (§9, D61).
 *
 * The re-verify is the honest part: a sponsor chain broken by manual SQL is
 * unreachable from the walk and cannot be repaired by re-deriving from
 * pointers, so the summary reports `remaining > 0` instead of pretending.
 * A concurrent `fn_user_move` racing the rebuild is the one residual window;
 * the next nightly run converges (the advisory lock cannot block a manual
 * move, which runs in its own transaction outside the cron).
 */
async function treeVerify({ db }: JobRunContext): Promise<JobSummary> {
  const problems = await findTreeDivergences(db);
  if (problems.length === 0) {
    return { problems: 0, repairedUsers: 0, remaining: 0, notified: 0 };
  }

  const repairRows = await db.$queryRaw<Array<{ fixed: number }>>`
    /* @job:tree-rebuild */
    SELECT fn_tree_rebuild() AS fixed
  `;
  const repairedUsers = repairRows[0]?.fixed ?? 0;

  const remaining = await findTreeDivergences(db);

  await db.$executeRaw`
    /* @job:tree-audit */
    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      NULL,
      'tree.verify_repaired',
      'tree',
      'structure',
      ${JSON.stringify({
        divergences: problems.length,
        problems: problems.slice(0, AUDIT_PROBLEMS_CAP),
      })}::jsonb,
      ${JSON.stringify({ repairedUsers, remaining: remaining.length })}::jsonb
    )
  `;

  const body =
    remaining.length === 0
      ? `tree:verify encontró ${problems.length} divergencia(s) y reconstruyó la estructura del árbol.`
      : `tree:verify encontró ${problems.length} divergencia(s); tras reconstruir quedan ${remaining.length} sin resolver (cadena de patrocinadores rota).`;
  const notified = await db.$executeRaw`
    /* @job:tree-notify */
    INSERT INTO notifications (user_id, type, title, body, data)
    SELECT
      u.id,
      'tree.verify_alert',
      ${"Árbol reconstruido"},
      ${body},
      jsonb_build_object('divergences', ${problems.length}, 'remaining', ${remaining.length})
    FROM users u
    WHERE u.role IN ('ROOT', 'ADMIN')
      AND u.status = 'ACTIVE'
      AND u.deleted_at IS NULL
  `;

  return {
    problems: problems.length,
    repairedUsers,
    remaining: remaining.length,
    notified,
  };
}

/** Job name -> runner. Only names listed in jobs/index.ts with implemented: true. */
const RUNNERS: Record<string, JobRunner> = {
  "cycle:ensure": cycleEnsure,
  "cycle:obligations": cycleObligations,
  "cycle:reminders": cycleReminders,
  "cycle:close": cycleClose,
  "tree:verify": treeVerify,
};

/**
 * Jobs whose body is a read-decide-write critical section (D41 defers §9's
 * advisory lock to exactly these): two concurrent `cycle:reminders` runs could
 * both read "no report yet" and both insert a notification, and two
 * `cycle:close` runs could interleave a close with a late approval, and two
 * `tree:verify` runs could rebuild while the other decides there is nothing to
 * do. The guard-only jobs stay out — see the header: a caught 23P01 poisons an
 * open transaction, and their race tolerance depends on autocommit.
 */
const LOCKED_JOBS = new Set(["cycle:reminders", "cycle:close", "tree:verify"]);

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
