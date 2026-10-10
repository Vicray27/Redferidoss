// =============================================================================
// lib/cycles.ts — payment cycle window maths (R11, §3.2, §5.4, §9.1).
//
// A cycle is a half-open window [starts_at, ends_at) expressed in the GLOBAL
// timezone (`general.timezone`), never the browser's, and `due_at` is
// `ends_at + payments.grace_hours` (§5.4). `period_key` is the ISO-8601 week
// of the local start date, e.g. "2026-W41" (§5.4).
//
// No date library is added: Node 24 ships full ICU, so `Intl.DateTimeFormat`
// with an explicit `timeZone` resolves the local wall clock and the UTC
// instant. This matters because the local midnight that opens a cycle is NOT a
// fixed offset from UTC when the zone observes DST.
// =============================================================================

export const MS_PER_DAY = 86_400_000;

export type CycleFrequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

export interface CycleBounds {
  /** ISO-8601 week key of the local start date, e.g. "2026-W41". */
  periodKey: string;
  startsAt: Date;
  /** Exclusive upper bound: the next cycle's starts_at. */
  endsAt: Date;
  dueAt: Date;
}

export interface CycleBoundsInput {
  now: Date;
  timezone: string;
  /** 0 = Sunday ... 6 = Saturday (§3.2 R11, default 1 = Monday). */
  weekStartDay: number;
  graceHours: number;
  frequency?: CycleFrequency;
}

/**
 * §9's pseudocode anchors BIWEEKLY on `payments.epoch_date`, which the §6
 * catalog does not define (no epoch/anchor key exists in settings). Rather than
 * invent an anchor and silently produce wrong windows, only WEEKLY is
 * computable in F1. Documented as D11 in docs/decisiones.md; the anchor key
 * lands with the F7 `cycle:ensure` job.
 */
export class UnsupportedCycleFrequencyError extends Error {
  constructor(frequency: string) {
    super(
      `UNSUPPORTED_CYCLE_FREQUENCY: "${frequency}" needs an anchor setting that §6 does not ` +
        `define. Only WEEKLY is computable until the F7 cycle:ensure job defines it.`,
    );
    this.name = "UnsupportedCycleFrequencyError";
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): WallClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant.getTime() - (instant.getTime() % 1000));
}

/** Local wall clock in `timeZone` -> the UTC instant it denotes. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const wallMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Two passes settle DST transitions: the first guess uses the offset at the
  // naive instant, the second re-resolves it with the corrected instant.
  let instant = wallMs - zoneOffsetMs(new Date(wallMs), timeZone);
  instant = wallMs - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** ISO-8601 week key ("2026-W41") for a local calendar date. */
export function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDay = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - isoDay + 3); // Thursday owns the week
  const isoYear = date.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIsoDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDay + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Bounds of the cycle that contains `now` under the given configuration. */
export function computeCycleBounds({
  now,
  timezone,
  weekStartDay,
  graceHours,
  frequency = "WEEKLY",
}: CycleBoundsInput): CycleBounds {
  if (frequency !== "WEEKLY") throw new UnsupportedCycleFrequencyError(frequency);
  if (!Number.isInteger(weekStartDay) || weekStartDay < 0 || weekStartDay > 6) {
    throw new RangeError(`weekStartDay must be an integer 0..6, received ${weekStartDay}`);
  }
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    throw new RangeError(`graceHours must be a non-negative number, received ${graceHours}`);
  }

  let local: WallClock;
  try {
    local = zonedParts(now, timezone);
  } catch {
    throw new RangeError(`Unknown IANA timezone: "${timezone}"`);
  }

  const localMidnightUtc = Date.UTC(local.year, local.month - 1, local.day);
  const weekday = new Date(localMidnightUtc).getUTCDay();
  const daysBack = (weekday - weekStartDay + 7) % 7;
  const startWall = new Date(localMidnightUtc - daysBack * MS_PER_DAY);
  const nextWall = new Date(localMidnightUtc - daysBack * MS_PER_DAY + 7 * MS_PER_DAY);

  const startsAt = zonedToUtc(
    startWall.getUTCFullYear(),
    startWall.getUTCMonth() + 1,
    startWall.getUTCDate(),
    timezone,
  );
  const endsAt = zonedToUtc(
    nextWall.getUTCFullYear(),
    nextWall.getUTCMonth() + 1,
    nextWall.getUTCDate(),
    timezone,
  );

  return {
    periodKey: isoWeekKey(
      startWall.getUTCFullYear(),
      startWall.getUTCMonth() + 1,
      startWall.getUTCDate(),
    ),
    startsAt,
    endsAt,
    dueAt: new Date(endsAt.getTime() + graceHours * 3_600_000),
  };
}