import { describe, expect, it } from "vitest";

import {
  computeCycleBounds,
  daysBetweenLocalDates,
  effectiveCycleStatus,
  isReportable,
  isoWeekKey,
  localDateKey,
  planCycles,
  UnsupportedCycleFrequencyError,
} from "../lib/cycles";

/**
 * Pure date maths, no database. The invariants come straight from the spec:
 * R11 (the "week" is computed in `general.timezone`, never the browser's), §3.2
 * (week_start_day 0=Sunday..6=Saturday, default 1=Monday) and §5.4 (exclusive
 * `ends_at`, `due_at = ends_at + payments.grace_hours`, ISO period_key).
 */

const CARACAS = "America/Caracas"; // UTC-4, no DST
const MONDAY = 1;

describe("isoWeekKey", () => {
  it("matches the ISO-8601 week numbering, including year boundaries", () => {
    expect(isoWeekKey(2026, 1, 1)).toMatch(/^202[56]-W\d{2}$/);
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
    expect(isoWeekKey(2026, 1, 1)).toBe(isoWeekKey(2025, 12, 29));
    // A Sunday belongs to the week that started the previous Monday.
    expect(isoWeekKey(2026, 1, 4)).toBe(isoWeekKey(2025, 12, 29));
  });

  it("pads the week to two digits", () => {
    expect(isoWeekKey(2026, 10, 12)).toMatch(/^2026-W\d{2}$/);
  });
});

describe("localDateKey", () => {
  it("resolves the LOCAL calendar date, not the UTC one", () => {
    // 02:30 UTC is still Oct 15 in Caracas (22:30) but already Oct 16 in UTC.
    const instant = new Date("2026-10-16T02:30:00.000Z");
    expect(localDateKey(instant, "America/Caracas")).toBe("2026-10-15");
    expect(localDateKey(instant, "UTC")).toBe("2026-10-16");
  });

  it("zero-pads month and day", () => {
    expect(localDateKey(new Date("2026-01-05T12:00:00.000Z"), "UTC")).toBe("2026-01-05");
  });

  it("rejects an unknown timezone instead of guessing", () => {
    expect(() => localDateKey(new Date(), "Foo/Bar")).toThrow(RangeError);
  });
});

describe("daysBetweenLocalDates", () => {
  it("counts whole days between date keys, sign included", () => {
    expect(daysBetweenLocalDates("2026-10-15", "2026-10-16")).toBe(1);
    expect(daysBetweenLocalDates("2026-10-15", "2026-10-15")).toBe(0);
    expect(daysBetweenLocalDates("2026-10-16", "2026-10-15")).toBe(-1);
  });

  it("crosses month and year boundaries", () => {
    expect(daysBetweenLocalDates("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetweenLocalDates("2026-12-31", "2027-01-01")).toBe(1);
  });
});

describe("computeCycleBounds — weekly", () => {
  const base = { timezone: CARACAS, weekStartDay: MONDAY, graceHours: 48 } as const;

  it("opens the cycle on the configured week start, local midnight", () => {
    // Wednesday 2026-01-07 15:30 UTC = 11:30 Caracas, still in the week that
    // started Monday 2026-01-05.
    const bounds = computeCycleBounds({ ...base, now: new Date("2026-01-07T15:30:00Z") });

    expect(bounds.startsAt.toISOString()).toBe("2026-01-05T04:00:00.000Z"); // Mon 00:00 -04
    expect(bounds.periodKey).toBe(isoWeekKey(2026, 1, 5));
  });

  it("ends exclusively at the next local midnight, exactly seven days later", () => {
    const bounds = computeCycleBounds({ ...base, now: new Date("2026-01-07T15:30:00Z") });

    expect(bounds.endsAt.toISOString()).toBe("2026-01-12T04:00:00.000Z");
    const sevenDays = 7 * 24 * 3_600_000;
    expect(bounds.endsAt.getTime() - bounds.startsAt.getTime()).toBe(sevenDays);
  });

  it("adds the grace period to the exclusive end, not to the start", () => {
    const bounds = computeCycleBounds({ ...base, now: new Date("2026-01-07T15:30:00Z") });

    expect(bounds.dueAt.toISOString()).toBe("2026-01-14T04:00:00.000Z");
    expect(bounds.dueAt.getTime() - bounds.endsAt.getTime()).toBe(48 * 3_600_000);
  });

  it("returns the same window for every instant inside the same week", () => {
    const monday = computeCycleBounds({ ...base, now: new Date("2026-01-05T04:00:00Z") });
    const sunday = computeCycleBounds({ ...base, now: new Date("2026-01-11T23:59:00Z") });
    const beforeNext = computeCycleBounds({ ...base, now: new Date("2026-01-12T03:59:00Z") });

    expect(sunday.periodKey).toBe(monday.periodKey);
    expect(beforeNext.periodKey).toBe(monday.periodKey);
  });

  it("rolls over to the next period_key one second after the window closes", () => {
    const bounds = computeCycleBounds({ ...base, now: new Date("2026-01-12T04:00:00Z") });
    expect(bounds.periodKey).not.toBe(isoWeekKey(2026, 1, 5));
    expect(bounds.startsAt.toISOString()).toBe("2026-01-12T04:00:00.000Z");
  });

  it("honours week_start_day = 0 (Sunday) and = 6 (Saturday)", () => {
    const sundayStart = computeCycleBounds({
      ...base,
      weekStartDay: 0,
      now: new Date("2026-01-07T15:30:00Z"),
    });
    expect(sundayStart.startsAt.toISOString()).toBe("2026-01-04T04:00:00.000Z");

    const saturdayStart = computeCycleBounds({
      ...base,
      weekStartDay: 6,
      now: new Date("2026-01-07T15:30:00Z"),
    });
    expect(saturdayStart.startsAt.toISOString()).toBe("2026-01-03T04:00:00.000Z");
  });

  it("puts the instant on the correct side of local midnight, not UTC midnight", () => {
    // 2026-01-08T02:00Z is 2026-01-07 22:00 in Caracas: same cycle as the
    // 2026-01-07T15:30Z sample, though the UTC calendar day differs.
    const utcDay = computeCycleBounds({ ...base, now: new Date("2026-01-08T02:00:00Z") });
    expect(utcDay.periodKey).toBe(isoWeekKey(2026, 1, 5));
  });
});

describe("computeCycleBounds — rejected input", () => {
  const base = { now: new Date("2026-01-07T15:30:00Z"), weekStartDay: 1, graceHours: 48 } as const;

  it("refuses a weekStartDay outside 0..6", () => {
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, weekStartDay: 7 })).toThrow(RangeError);
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, weekStartDay: -1 })).toThrow(RangeError);
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, weekStartDay: 1.5 })).toThrow(RangeError);
  });

  it("refuses a negative grace period", () => {
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, graceHours: -1 })).toThrow(RangeError);
  });

  it("refuses an unknown timezone instead of falling back to UTC", () => {
    expect(() => computeCycleBounds({ ...base, timezone: "Mars/Olympus", graceHours: 48 })).toThrow(
      RangeError,
    );
  });

  it("refuses BIWEEKLY/MONTHLY: §6 defines no anchor for them (D11)", () => {
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, frequency: "BIWEEKLY" })).toThrow(
      UnsupportedCycleFrequencyError,
    );
    expect(() => computeCycleBounds({ ...base, timezone: CARACAS, frequency: "MONTHLY" })).toThrow(
      /anchor/,
    );
  });
});

describe("computeCycleBounds — timezone handling", () => {
  it("resolves a DST zone to a wall-clock start, keeping the local hour at 00:00", () => {
    // New York is UTC-4 in January and UTC-5 in July. The cycle must open at
    // local midnight in both cases, so the UTC offset of starts_at changes.
    const winter = computeCycleBounds({
      now: new Date("2026-01-07T15:30:00Z"),
      timezone: "America/New_York",
      weekStartDay: 1,
      graceHours: 48,
    });
    const summer = computeCycleBounds({
      now: new Date("2026-07-08T15:30:00Z"),
      timezone: "America/New_York",
      weekStartDay: 1,
      graceHours: 48,
    });

    expect(winter.startsAt.toISOString()).toBe("2026-01-05T05:00:00.000Z"); // EST
    expect(summer.startsAt.toISOString()).toBe("2026-07-06T04:00:00.000Z"); // EDT
  });
});

describe("planCycles — consecutive windows (F4, §5.4)", () => {
  const base = { timezone: CARACAS, weekStartDay: MONDAY, graceHours: 48 } as const;

  it("returns the current window plus four future ones, contiguous by construction", () => {
    const windows = planCycles({ ...base, now: new Date("2026-01-07T15:30:00Z") }, 5);

    expect(windows).toHaveLength(5);
    expect(windows[0].periodKey).toBe(isoWeekKey(2026, 1, 5));
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].startsAt.getTime()).toBe(windows[index - 1].endsAt.getTime());
      expect(windows[index].periodKey).not.toBe(windows[index - 1].periodKey);
    }
  });

  it("keeps windows contiguous across a DST transition", () => {
    // New York springs forward on 2026-03-08: the week of 03-09 starts at a
    // different UTC offset than the week before it, yet still abuts it.
    const windows = planCycles(
      {
        now: new Date("2026-03-04T15:30:00Z"),
        timezone: "America/New_York",
        weekStartDay: MONDAY,
        graceHours: 48,
      },
      5,
    );

    expect(windows[0].startsAt.toISOString()).toBe("2026-03-02T05:00:00.000Z"); // EST
    expect(windows[1].startsAt.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // EDT
    expect(windows[1].startsAt.getTime()).toBe(windows[0].endsAt.getTime());
    expect(windows[2].startsAt.getTime()).toBe(windows[1].endsAt.getTime());
  });

  it("refuses a non-positive count", () => {
    expect(() => planCycles({ ...base, now: new Date("2026-01-07T15:30:00Z") }, 0)).toThrow(
      RangeError,
    );
  });
});

describe("effectiveCycleStatus / isReportable (F4, §5.4, §5.9)", () => {
  const row = {
    status: "OPEN",
    startsAt: new Date("2026-01-05T04:00:00.000Z"), // Mon 00:00 Caracas
    endsAt: new Date("2026-01-12T04:00:00.000Z"),
    dueAt: new Date("2026-01-14T04:00:00.000Z"), // +48h grace
  };

  it("labels OPEN inside the window and GRACE after ends_at", () => {
    expect(effectiveCycleStatus(row, new Date("2026-01-05T04:00:00Z"))).toBe("OPEN");
    expect(effectiveCycleStatus(row, new Date("2026-01-11T23:59:00Z"))).toBe("OPEN");
    expect(effectiveCycleStatus(row, new Date("2026-01-12T04:00:00Z"))).toBe("GRACE");
    expect(effectiveCycleStatus(row, new Date("2026-01-14T03:59:59Z"))).toBe("GRACE");
  });

  it("A6: Sunday 23:59 in Caracas is still the closing week's cycle", () => {
    // Sunday 2026-01-11 23:59 Caracas (-04) == 2026-01-12 03:59 UTC.
    const lastMinute = new Date("2026-01-12T03:59:00Z");
    const bounds = computeCycleBounds({
      now: lastMinute,
      timezone: CARACAS,
      weekStartDay: MONDAY,
      graceHours: 48,
    });

    expect(bounds.periodKey).toBe(isoWeekKey(2026, 1, 5));
    expect(effectiveCycleStatus({ ...row, ...bounds }, lastMinute)).toBe("OPEN");
    expect(isReportable({ ...row, ...bounds }, lastMinute)).toBe(true);
    // One minute later the window has closed and the grace period begins.
    expect(effectiveCycleStatus({ ...row, ...bounds }, new Date("2026-01-12T04:00:00Z"))).toBe(
      "GRACE",
    );
    expect(isReportable({ ...row, ...bounds }, new Date("2026-01-12T04:00:00Z"))).toBe(true);
  });

  it("closes at due_at exactly", () => {
    expect(effectiveCycleStatus(row, new Date("2026-01-14T04:00:00Z"))).toBe("CLOSED");
    expect(isReportable(row, new Date("2026-01-14T04:00:00Z"))).toBe(false);
  });

  it("treats a stored CLOSED as terminal, whatever the clock says", () => {
    const settled = { ...row, status: "CLOSED" };
    expect(effectiveCycleStatus(settled, new Date("2026-01-06T00:00:00Z"))).toBe("CLOSED");
    expect(isReportable(settled, new Date("2026-01-06T00:00:00Z"))).toBe(false);
  });

  it("refuses a report before the window opens", () => {
    expect(isReportable(row, new Date("2026-01-04T00:00:00Z"))).toBe(false);
    expect(effectiveCycleStatus(row, new Date("2026-01-04T00:00:00Z"))).toBe("OPEN");
  });
});