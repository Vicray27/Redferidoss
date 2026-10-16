// =============================================================================
// jobs/index.ts — §9 scheduled job registry.
//
// Every scheduled task in the spec is registered here so the cron route has a
// single allow-list to validate `{job}` against. F4a implemented the first two
// cycle jobs; F7 is landing the rest one body at a time (cycle:reminders
// first) — their bodies live in jobs/execute.ts, wired to their names there —
// so the route dispatches them instead of answering 501. The pg_cron
// scheduling (or the node-cron fallback from D1) lands with the F7 scheduler.
//
// §9: "Idempotentes (usar advisory locks: pg_try_advisory_lock)" — the
// guard-only jobs are idempotent by construction (guarded INSERTs); D41
// documents why the advisory lock belongs to the multi-statement jobs and how
// jobs/execute.ts takes it (interactive transaction + xact lock).
//
// `implemented: true` is what lets the route hand the name to executeJob;
// `implemented: false` keeps the honest 501.
// =============================================================================

export interface JobDefinition {
  /** Path segment accepted by POST /api/cron/{job}. */
  name: string;
  /** Human description, §9 table. */
  description: string;
  /** Spec schedule, kept for the F7 pg_cron / node-cron configuration. */
  schedule: string;
  implemented: boolean;
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: "cycle:ensure",
    description: "Guarantees the cycle containing now() exists and creates the next four.",
    schedule: "every hour",
    implemented: true,
  },
  {
    name: "cycle:obligations",
    description: "Inserts cycle_obligations for every ACTIVE user when a cycle is created.",
    schedule: "on cycle creation",
    implemented: true,
  },
  {
    name: "cycle:reminders",
    description: "Notifies users who have not reported, per payments.reminder_days_before_due.",
    schedule: "daily 09:00 (global timezone)",
    implemented: true,
  },
  {
    name: "cycle:close",
    description: "Marks unfulfilled obligations MISSED, closes the cycle, accrues strikes.",
    schedule: "every hour",
    implemented: false,
  },
  {
    name: "tree:verify",
    description: "Compares user_closure/path against the recursive traversal and repairs.",
    schedule: "daily 03:00",
    implemented: false,
  },
  {
    name: "files:gc",
    description: "Deletes orphaned proof objects from S3-compatible storage.",
    schedule: "weekly",
    implemented: false,
  },
];

const JOBS_BY_NAME = new Map(JOBS.map((job) => [job.name, job]));

/** Null when `{job}` is not a registered name, so the route can answer 404. */
export function findJob(name: string): JobDefinition | undefined {
  return JOBS_BY_NAME.get(name);
}