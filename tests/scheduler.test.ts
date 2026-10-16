import { describe, expect, it, vi } from "vitest";

import { JOBS } from "../jobs/index";
import { computeDueJobs, msUntilNextMinute, startScheduler, zonedClock } from "../jobs/scheduler";

// 2026-01-15T13:00:05Z is 09:00 Thursday in Caracas (UTC-4), the slot where
// the daily reminder coincides with the hourly jobs.
const NINE_AM_CARACAS = new Date("2026-01-15T13:00:05Z");

const names = (now: Date, timeZone: string) => computeDueJobs(now, timeZone).map((job) => job.name);

describe("computeDueJobs", () => {
  it("matches the exact local minute in the global timezone, in registry order", () => {
    // 13:00Z is also minute 780, a 5-minute stride: mv:refresh is due too.
    expect(names(NINE_AM_CARACAS, "America/Caracas")).toEqual([
      "cycle:ensure",
      "cycle:obligations",
      "cycle:reminders",
      "cycle:close",
      "mv:refresh",
    ]);
  });

  it("is timezone-aware, not UTC", () => {
    // The same instant is 13:00 UTC: hourly slots plus the timezone-free
    // interval job and nothing else.
    expect(names(NINE_AM_CARACAS, "UTC")).toEqual([
      "cycle:ensure",
      "cycle:obligations",
      "cycle:close",
      "mv:refresh",
    ]);
  });

  it("fires tree:verify only at its local 03:00", () => {
    const threeAmCaracas = new Date("2026-01-15T07:00:30Z");
    expect(names(threeAmCaracas, "America/Caracas")).toEqual([
      "cycle:ensure",
      "cycle:obligations",
      "cycle:close",
      "tree:verify",
      "mv:refresh",
    ]);
    expect(names(threeAmCaracas, "UTC")).not.toContain("tree:verify");
  });

  it("fires mv:refresh on absolute 5-minute epoch strides, in every timezone", () => {
    // 07:03:40Z is minute 423: 423 % 5 !== 0, so the interval job waits.
    const offStride = new Date("2026-01-15T07:03:40Z");
    expect(names(offStride, "America/Caracas")).not.toContain("mv:refresh");
    expect(names(offStride, "UTC")).not.toContain("mv:refresh");

    // 07:05:12Z is minute 425: due, and identically due in both zones — a
    // timezone change must not re-phase the cadence (§14, D67).
    const onStride = new Date("2026-01-15T07:05:12Z");
    expect(names(onStride, "America/Caracas")).toContain("mv:refresh");
    expect(names(onStride, "UTC")).toContain("mv:refresh");
  });

  it("never fires a malformed interval instead of firing every minute", () => {
    const broken = [{ ...JOBS[0]!, timing: { kind: "interval" as const, minutes: 0 } }];
    const negative = [{ ...JOBS[0]!, timing: { kind: "interval" as const, minutes: -5 } }];

    expect(computeDueJobs(NINE_AM_CARACAS, "UTC", broken)).toEqual([]);
    expect(computeDueJobs(NINE_AM_CARACAS, "UTC", negative)).toEqual([]);
  });

  it("fires files:gc only on the local Sunday 04:00", () => {
    const sunday = new Date("2026-01-18T08:00:10Z"); // Sunday 04:00 Caracas
    const monday = new Date("2026-01-19T08:00:10Z"); // Monday 04:00 Caracas
    expect(names(sunday, "America/Caracas")).toContain("files:gc");
    expect(names(monday, "America/Caracas")).not.toContain("files:gc");
  });

  it("keeps cycle:ensure before its consumers (registry order is load-bearing)", () => {
    const due = names(NINE_AM_CARACAS, "America/Caracas");
    expect(due.indexOf("cycle:ensure")).toBeLessThan(due.indexOf("cycle:obligations"));
    expect(due.indexOf("cycle:obligations")).toBeLessThan(due.indexOf("cycle:close"));
  });

  it("every registered job declares its timing", () => {
    expect(JOBS).toHaveLength(7);
    for (const job of JOBS) expect(job.timing, job.name).toBeDefined();
  });

  it("throws on an unsupported timezone instead of silently never firing", () => {
    expect(() => zonedClock(new Date(), "Not/AZone")).toThrow(/Not\/AZone/);
  });
});

describe("msUntilNextMinute", () => {
  it("returns the distance to the next minute boundary", () => {
    expect(msUntilNextMinute(new Date("2026-01-15T13:00:05.500Z"))).toBe(54_500);
  });

  it("returns a full minute exactly on the boundary (the current minute is owned)", () => {
    expect(msUntilNextMinute(new Date("2026-01-15T13:00:00.000Z"))).toBe(60_000);
  });
});

describe("startScheduler", () => {
  const fakes = () => {
    const timers: Array<() => void> = [];
    const ran: string[] = [];
    const errors: string[] = [];
    return {
      timers,
      ran,
      errors,
      deps: {
        now: () => NINE_AM_CARACAS,
        getTimezone: async () => "America/Caracas",
        setTimer: (fn: () => void) => {
          timers.push(fn);
          return timers.length;
        },
        clearTimer: () => {},
        log: () => {},
      },
    };
  };

  it("runs due jobs sequentially, isolates one failure, and reschedules itself", async () => {
    const { timers, ran, errors, deps } = fakes();
    const handle = startScheduler({
      ...deps,
      runJob: async (name) => {
        ran.push(name);
        if (name === "cycle:obligations") throw new Error("boom");
        return { ok: true };
      },
      error: (message) => errors.push(message),
    });
    expect(timers).toHaveLength(1);

    timers[0]();
    await vi.waitFor(() => expect(ran).toHaveLength(5));
    expect(ran).toEqual(["cycle:ensure", "cycle:obligations", "cycle:reminders", "cycle:close", "mv:refresh"]);
    expect(errors).toEqual(["[jobs] cycle:obligations failed"]);
    expect(timers).toHaveLength(2); // the loop scheduled the next minute
    handle.stop();
  });

  it("evaluates each minute at most once", async () => {
    const { timers, ran, deps } = fakes();
    const handle = startScheduler({ ...deps, runJob: async (name) => ran.push(name) });

    timers[0]();
    await vi.waitFor(() => expect(ran).toHaveLength(5));
    expect(timers).toHaveLength(2);

    timers[1](); // same injected instant: same minute, must be a no-op
    expect(ran).toHaveLength(5);
    expect(timers).toHaveLength(3); // but it still schedules the following one
    handle.stop();
  });

  it("stop() makes the next fired timer a no-op", async () => {
    const { timers, ran, deps } = fakes();
    const handle = startScheduler({ ...deps, runJob: async (name) => ran.push(name) });

    timers[0]();
    await vi.waitFor(() => expect(ran).toHaveLength(5));
    handle.stop();
    timers[1]();
    expect(ran).toHaveLength(5);
  });
});
