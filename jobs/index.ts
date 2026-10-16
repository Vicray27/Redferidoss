// =============================================================================
// jobs/index.ts — §9 scheduled job registry.
//
// Every scheduled task in the spec is registered here so the cron route has a
// single allow-list to validate `{job}` against. All six bodies live in
// jobs/execute.ts; the cadence runs in jobs/scheduler.ts, started by
// instrumentation.ts (D62), and the authenticated route stays as a
// manual/external trigger. `implemented: true` is what lets the route hand
// the name to executeJob; `implemented: false` keeps the honest 501 for the
// next job that lands registry-first.
//
// §9: "Idempotentes (usar advisory locks: pg_try_advisory_lock)" — the
// guard-only jobs are idempotent by construction (guarded INSERTs); D41
// documents why the advisory lock belongs to the multi-statement jobs and how
// jobs/execute.ts takes it (interactive transaction + xact lock).
//
// `implemented: true` is what lets the route hand the name to executeJob;
// `implemented: false` keeps the honest 501.
// =============================================================================

/**
 * Machine-readable counterpart of `schedule`, consumed by jobs/scheduler.ts
 * (D62). All times are LOCAL to `general.timezone`, never UTC: the church
 * lives in one timezone and the settings row is the only source of truth for
 * what "09:00" means (§9).
 *
 * `weekday` follows the JS convention (0 = Sunday) because the scheduler
 * derives it from Intl weekday names and the comparison stays a plain number.
 */
export type JobTiming =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export interface JobDefinition {
  /** Path segment accepted by POST /api/cron/{job}. */
  name: string;
  /** Human description, §9 table. */
  description: string;
  /** Spec schedule, kept for the F7 pg_cron / node-cron configuration. */
  schedule: string;
  /** When the in-process scheduler fires it, in the global timezone. */
  timing: JobTiming;
  implemented: boolean;
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: "cycle:ensure",
    description: "Guarantees the cycle containing now() exists and creates the next four.",
    schedule: "every hour",
    timing: { kind: "hourly", minute: 0 },
    implemented: true,
  },
  {
    name: "cycle:obligations",
    description: "Inserts cycle_obligations for every ACTIVE user when a cycle is created.",
    schedule: "on cycle creation",
    timing: { kind: "hourly", minute: 0 },
    implemented: true,
  },
  {
    name: "cycle:reminders",
    description: "Notifies users who have not reported, per payments.reminder_days_before_due.",
    schedule: "daily 09:00 (global timezone)",
    timing: { kind: "daily", hour: 9, minute: 0 },
    implemented: true,
  },
  {
    name: "cycle:close",
    description: "Marks unfulfilled obligations MISSED, closes the cycle, accrues strikes.",
    schedule: "every hour",
    timing: { kind: "hourly", minute: 0 },
    implemented: true,
  },
  {
    name: "tree:verify",
    description: "Compares user_closure/path against the recursive traversal and repairs.",
    schedule: "daily 03:00",
    timing: { kind: "daily", hour: 3, minute: 0 },
    implemented: true,
  },
  {
    name: "files:gc",
    description: "Deletes orphaned proof objects from S3-compatible storage.",
    schedule: "weekly (Sunday 04:00)",
    timing: { kind: "weekly", weekday: 0, hour: 4, minute: 0 },
    implemented: true,
  },
];

const JOBS_BY_NAME = new Map(JOBS.map((job) => [job.name, job]));

/** Null when `{job}` is not a registered name, so the route can answer 404. */
export function findJob(name: string): JobDefinition | undefined {
  return JOBS_BY_NAME.get(name);
}