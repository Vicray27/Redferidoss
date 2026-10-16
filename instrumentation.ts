// =============================================================================
// instrumentation.ts — Next.js process-startup hook; owns the job scheduler.
//
// Next calls `register()` once per server process before serving requests.
// The scheduler starts here instead of inside the cron route because §9's
// cadence is a background concern: the route stays a thin manual/external
// trigger (pg_cron, uptime pingers, or an operator), and Docker needs no
// pg_cron extension. D62 records why the schedule lives in the app process.
//
// Next compiles this module for BOTH runtimes (node and edge). The scheduler
// needs Prisma, which is Node-only, so the dynamic import MUST live inside a
// POSITIVE `NEXT_RUNTIME === "nodejs"` branch: webpack evaluates that guard
// per compilation and drops the branch — import included — for the edge
// build, keeping `pg` and Node builtins out of the edge bundle. A negative
// guard (`if (NEXT_RUNTIME !== "nodejs") return;` with the import after it)
// does NOT work: the import stays a reachable top-level statement and still
// enters the edge module graph.
//
// Remaining guards, cheapest and safest first:
//   * development: `next dev` restarts and HMR can re-evaluate modules, and a
//     second loop would double-tick; local runs use POST /api/cron/{job};
//   * build phase: Next evaluates the module graph while building;
//   * JOBS_SCHEDULER=off: the operator kill switch, no redeploy needed.
//
// The globalThis flag is the last line of defense against a second loop in
// one process (the scheduler itself trusts its caller, D62).
// =============================================================================

const SCHEDULER_STARTED_FLAG = "__redReferidosJobsSchedulerStarted";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NODE_ENV !== "production") return;
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (process.env.JOBS_SCHEDULER === "off") return;

    const scope = globalThis as typeof globalThis & { [SCHEDULER_STARTED_FLAG]?: boolean };
    if (scope[SCHEDULER_STARTED_FLAG]) return;
    scope[SCHEDULER_STARTED_FLAG] = true;

    const { startScheduler } = await import("./jobs/scheduler");
    startScheduler();
    console.log("[jobs] in-process scheduler started; POST /api/cron/{job} stays available (D62)");
  }
}
