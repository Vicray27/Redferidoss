// =============================================================================
// jobs/scheduler.ts — in-process scheduler for §9's recurring jobs (D62).
//
// Why in the app process and not pg_cron: the cadence belongs to the same
// deployment as the code that runs it. pg_cron would require swapping the
// stock postgres:16 image (D1 deferred that image choice to F7) and would
// couple the schedule to the database migration workflow, while adding no
// capability the app process does not already have. The trade is explicit:
// the scheduler assumes a SINGLE app process; with horizontal scaling every
// replica would tick, and the jobs' idempotency + advisory locks (D41/D59)
// are the safety net, not the plan. D62 records this.
//
// Mechanism: aligned wall-clock ticking, not a cron parser. Each tick wakes
// at second 0 of a minute, asks `computeDueJobs` which registry entries match
// that local minute, and runs them sequentially in registry order (registry
// order is load-bearing: cycle:ensure before cycle:obligations). A tick never
// overlaps itself, and a minute is evaluated at most once, so a delayed wake-up
// cannot double-fire an hourly slot.
//
// Everything external is injectable so tests drive the loop with a fake clock
// and fake timer: the DB, the clock, the timer functions and the logger.
// =============================================================================

import { prisma } from "../lib/db";
import { settings } from "../lib/settings";
import { executeJob } from "./execute";
import { JOBS, type JobDefinition } from "./index";

/** Weekday names as en-US Intl reports them; index = JS Date.getDay() value. */
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface SchedulerDeps {
  /** Global timezone from settings; read every tick so a change applies live. */
  getTimezone(): Promise<string>;
  runJob(name: string): Promise<unknown>;
  now?(): Date;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?(message: string): void;
  error?(message: string, error: unknown): void;
}

export interface SchedulerHandle {
  /** Idempotent; a tick already running finishes, nothing new is scheduled. */
  stop(): void;
}

export interface ZonedClock {
  /** 0 = Sunday, matching JobTiming.weekday. */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * The wall-clock face of `now` in `timeZone` — the ONLY place the scheduler
 * looks at a clock, so every timing comparison is timezone-aware by
 * construction. `hourCycle: "h23"` avoids the "24" that en-US hour12:false
 * produces at midnight.
 */
export function zonedClock(now: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekday = WEEKDAY_NAMES.indexOf(read("weekday") as (typeof WEEKDAY_NAMES)[number]);
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));

  if (weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Unsupported timezone for the job scheduler: ${timeZone}`);
  }
  return { weekday, hour, minute };
}

/**
 * Registry entries due at `now` in `timeZone`, in registry order. Pure and
 * exported for the tests: this is the entire cron semantics — exact local
 * minute match, weekly adds the weekday.
 */
export function computeDueJobs(
  now: Date,
  timeZone: string,
  jobs: readonly JobDefinition[] = JOBS,
): JobDefinition[] {
  const clock = zonedClock(now, timeZone);
  return jobs.filter((job) => {
    const { timing } = job;
    if (timing.kind === "hourly") return clock.minute === timing.minute;
    if (timing.kind === "daily") {
      return clock.hour === timing.hour && clock.minute === timing.minute;
    }
    return clock.weekday === timing.weekday && clock.hour === timing.hour && clock.minute === timing.minute;
  });
}

/**
 * Milliseconds from `now` to second 0 of the next minute. At exactly :00.000
 * it returns a full minute, which is deliberate: the tick that just fired owns
 * this minute, the next one starts the following minute.
 */
export function msUntilNextMinute(now: Date): number {
  return 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
}

/**
 * Starts the loop and returns its handle. Safe to call with zero arguments in
 * production (wired to Prisma, settings and executeJob); tests inject fakes.
 * Singleton discipline lives in instrumentation.ts — this function trusts its
 * caller, one loop per call.
 */
export function startScheduler(overrides: Partial<SchedulerDeps> = {}): SchedulerHandle {
  const deps: Required<SchedulerDeps> = {
    getTimezone: async () => settings.getOrThrow<string>("general.timezone"),
    runJob: (name) => executeJob(name, { db: prisma, settings, now: new Date() }),
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (message) => console.log(message),
    error: (message, error) => console.error(message, error),
    ...overrides,
  };

  const state: { stopped: boolean; running: boolean; handle: unknown; lastMinuteKey: number } = {
    stopped: false,
    running: false,
    handle: undefined,
    lastMinuteKey: -1,
  };

  const scheduleNext = (): void => {
    if (state.stopped) return;
    state.handle = deps.setTimer(() => void tick(), msUntilNextMinute(deps.now()));
  };

  const tick = async (): Promise<void> => {
    if (state.stopped) return;

    // A minute is evaluated at most once: a wake-up that drifted into the
    // next slot must not re-run an hourly job the previous tick already ran.
    const minuteKey = Math.floor(deps.now().getTime() / 60_000);
    if (minuteKey === state.lastMinuteKey) {
      scheduleNext();
      return;
    }
    state.lastMinuteKey = minuteKey;

    // A slow tick (say, a big files:gc) can outlive its minute. The next slot
    // waits instead of overlapping — idempotency + advisory locks are the
    // safety net, not the plan (D62).
    if (state.running) {
      scheduleNext();
      return;
    }

    state.running = true;
    try {
      const timezone = await deps.getTimezone();
      for (const job of computeDueJobs(deps.now(), timezone)) {
        if (!job.implemented) continue;
        try {
          const summary = await deps.runJob(job.name);
          deps.log(`[jobs] ${job.name} ok ${JSON.stringify(summary)}`);
        } catch (error) {
          // One failing job never cancels the others: every body is
          // idempotent, and the next matching slot IS the retry.
          deps.error(`[jobs] ${job.name} failed`, error);
        }
      }
    } catch (error) {
      // A broken tick (settings unreadable, DB down) must not kill the loop.
      deps.error("[jobs] scheduler tick failed", error);
    } finally {
      state.running = false;
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop(): void {
      state.stopped = true;
      if (state.handle !== undefined) deps.clearTimer(state.handle);
    },
  };
}
