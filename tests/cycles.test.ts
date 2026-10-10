import { describe, expect, it } from "vitest";

import { computeCycleBounds, isoWeekKey, UnsupportedCycleFrequencyError } from "../lib/cycles";

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