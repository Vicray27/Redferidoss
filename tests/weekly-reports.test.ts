// =============================================================================
// tests/weekly-reports.test.ts â€” Â§8.4 self-service weekly report + A6 boundary.
//
// The fake db routes by `/* @weekly:â€¦ */` markers; the fake authz returns the
// same duck-typed SQL fragment the real `scopeFilter` produces, so the scope
// assertions prove the fragment is ANDed into the downline statement.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import type { SessionActor } from "../lib/authz";
import {
  createWeeklyReportsService,
  validateWeeklyReportInput,
  type WeeklyReportInput,
  type WeeklyReportsAuthz,
  type WeeklyReportsDb,
} from "../lib/weekly-reports";

const ACTOR: SessionActor = { userId: "user-1", role: "MEMBER" };
const NOW = new Date("2026-10-15T12:00:00.000Z");
/** Sunday 23:59 in UTC-5 == 2026-10-19T04:59:00Z (A6 boundary). */
const SUNDAY_2359_LOCAL = new Date("2026-10-19T04:59:00.000Z");
/** Monday 00:01 in UTC-5 == 2026-10-19T05:01:00Z. */
const MONDAY_0001_LOCAL = new Date("2026-10-19T05:01:00.000Z");

type Handler = (values: unknown[]) => unknown;

function isSqlLike(value: unknown): value is { sql: string; values: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { sql?: unknown; values?: unknown };
  return typeof candidate.sql === "string" && Array.isArray(candidate.values);
}

class WeeklyFake implements WeeklyReportsDb {
  readonly calls: Array<{ marker: string; text: string; values: unknown[] }> = [];
  private readonly handlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.handlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; text: string; values: unknown[] }> {
    return this.calls.filter((call) => call.marker === marker);
  }

  valuesOf(marker: string): unknown[] {
    return this.callsFor(marker)[0]?.values ?? [];
  }

  /** The innermost non-empty scope fragment embedded in a call, if any. */
  scopeFragmentOf(marker: string): { sql: string; values: unknown[] } | null {
    const scan = (values: unknown[]): { sql: string; values: unknown[] } | null => {
      for (const value of values) {
        if (isSqlLike(value)) {
          const nested = scan(value.values);
          if (nested) return nested;
          if (value.sql.trim() !== "") return value;
        }
      }
      return null;
    };
    for (const call of this.callsFor(marker)) {
      const found = scan(call.values);
      if (found) return found;
    }
    return null;
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @weekly:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`WeeklyFake: unmarked statement: ${text}`);
    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`WeeklyFake: no handler for ${marker}`);
    this.calls.push({ marker, text, values });
    return (await handler(values)) as T;
  }
}

function makeAuthz(overrides: { unrestricted?: boolean; fragmentSql?: string } = {}) {
  const scopeCalls: Array<{ actor: unknown; options?: { alias?: string } }> = [];
  const authz: WeeklyReportsAuthz = {
    async scopeFilter(actor, options) {
      scopeCalls.push({ actor, options });
      return {
        fragment: { sql: overrides.fragmentSql ?? "u.path <@ ?::ltree AND u.depth <= ?", values: ["root.abc", 1] } as unknown as Prisma.Sql,
        unrestricted: overrides.unrestricted ?? false,
      };
    },
  };
  return { authz, scopeCalls };
}

function build(now: Date | (() => Date) = NOW) {
  const db = new WeeklyFake();
  const { authz, scopeCalls } = makeAuthz();
  const currentNow = typeof now === "function" ? now : () => now;

  db.on("cycle-window", () => [{ id: "cycle-1", period_key: "2026-W42" }])
    .on("upsert", () => [{ id: "weekly-1", updated_at: currentNow() }])
    .on("my-reports", () => [])
    .on("downline-reports", () => []);

  const service = createWeeklyReportsService(db, authz, { now: currentNow });
  return { db, service, scopeCalls };
}

function baseInput(overrides: Partial<WeeklyReportInput> = {}): WeeklyReportInput {
  return {
    attended: true,
    discipleshipAttended: false,
    cellsTotal: 1,
    cellsHeld: 1,
    cellsNotHeld: 0,
    cellAttendees: 5,
    cellAbsentees: 2,
    cellNewVisitors: 1,
    cellNewCells: 0,
    visitors: [],
    note: null,
    ...overrides,
  };
}

describe("saveReport", () => {
  it("upserts the report for the current cycle with every counter and the visitors JSON", async () => {
    const { db, service } = build();

    const result = await service.saveReport(ACTOR, baseInput({ visitors: ["Juan", "  MarÃ­a "], note: "  buena reuniÃ³n  " }));

    expect(result).toEqual({ id: "weekly-1", cycleId: "cycle-1", periodKey: "2026-W42", updatedAt: NOW });
    const values = db.valuesOf("upsert");
    expect(values).toContain(ACTOR.userId);
    expect(values).toContain("cycle-1");
    expect(values).toContain(true);
    expect(values).toContain(5);
    expect(values).toContain('["Juan","MarÃ­a"]');
    expect(values).toContain("buena reuniÃ³n");
  });

  it("reports a conflict when no cycle is open", async () => {
    const { db, service } = build();
    db.on("cycle-window", () => []);

    await expect(service.saveReport(ACTOR, baseInput())).rejects.toMatchObject({ code: "NO_REPORT_WINDOW" });
  });

  it("excludes a stored CLOSED cycle from the report window (D37/S1)", async () => {
    const { db, service } = build();

    await service.saveReport(ACTOR, baseInput());

    expect(db.callsFor("cycle-window")[0]!.text).toContain("status <> 'CLOSED'");
  });

  it("rejects invalid counters and non-boolean attendance", async () => {
    const { service } = build();

    await expect(service.saveReport(ACTOR, baseInput({ cellsHeld: -1 }))).rejects.toMatchObject({ details: { cellsHeld: expect.any(String) } });
    await expect(service.saveReport(ACTOR, baseInput({ cellAttendees: 10000 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.saveReport(ACTOR, baseInput({ cellsTotal: 1.5 }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      service.saveReport(ACTOR, { ...baseInput(), attended: "sÃ­" } as unknown as WeeklyReportInput),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("validates the visitor list: array, limit and non-empty names", async () => {
    const { service } = build();

    await expect(
      service.saveReport(ACTOR, { ...baseInput(), visitors: "Juan" } as unknown as WeeklyReportInput),
    ).rejects.toMatchObject({ details: { visitors: expect.any(String) } });
    await expect(service.saveReport(ACTOR, baseInput({ visitors: ["   "] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const tooMany = Array.from({ length: 51 }, (_, index) => `Visitante ${index}`);
    await expect(service.saveReport(ACTOR, baseInput({ visitors: tooMany }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("caps the note length", async () => {
    const { service } = build();

    await expect(service.saveReport(ACTOR, baseInput({ note: "x".repeat(2001) }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { note: expect.any(String) },
    });
  });

  it("binds Sunday 23:59 local to the closing cycle and Monday 00:01 to the next one (A6)", async () => {
    let currentNow = SUNDAY_2359_LOCAL;
    const db = new WeeklyFake();
    const { authz } = makeAuthz();
    db.on("cycle-window", (values) => {
      const at = values[0] as Date;
      return at.getTime() < MONDAY_0001_LOCAL.getTime()
        ? [{ id: "cycle-w42", period_key: "2026-W42" }]
        : [{ id: "cycle-w43", period_key: "2026-W43" }];
    }).on("upsert", () => [{ id: "weekly-1", updated_at: currentNow }]);

    const service = createWeeklyReportsService(db, authz, { now: () => currentNow });

    await expect(service.saveReport(ACTOR, baseInput())).resolves.toMatchObject({ periodKey: "2026-W42" });
    currentNow = MONDAY_0001_LOCAL;
    await expect(service.saveReport(ACTOR, baseInput())).resolves.toMatchObject({ periodKey: "2026-W43" });
  });
});

describe("myReports", () => {
  it("lists newest-first and clamps the limit", async () => {
    const { db, service } = build();

    await service.myReports(ACTOR, { limit: 500 });

    expect(db.valuesOf("my-reports")).toEqual([ACTOR.userId, 100]);
  });
});

describe("downlineReports", () => {
  it("resolves the current cycle, ANDs the authorization scope and queries with alias u", async () => {
    const { db, service, scopeCalls } = build();

    await service.downlineReports(ACTOR);

    expect(scopeCalls[0]?.options).toEqual({ alias: "u" });
    const values = db.valuesOf("downline-reports");
    expect(values).toContain("cycle-1");
    expect(values).toContain(ACTOR.userId);
    const fragment = db.scopeFragmentOf("downline-reports");
    expect(fragment?.sql).toContain("u.path <@");
    expect(fragment?.values).toEqual(["root.abc", 1]);
  });

  it("skips the cycle lookup when an explicit cycleId is given", async () => {
    const { db, service } = build();

    await service.downlineReports(ACTOR, { cycleId: "cycle-9", limit: 10 });

    expect(db.callsFor("cycle-window")).toHaveLength(0);
    expect(db.valuesOf("downline-reports")).toContain("cycle-9");
  });

  it("omits the scope condition when the actor is unrestricted", async () => {
    const db = new WeeklyFake();
    const { authz } = makeAuthz({ unrestricted: true });
    db.on("cycle-window", () => [{ id: "cycle-1", period_key: "2026-W42" }]).on("downline-reports", () => []);
    const service = createWeeklyReportsService(db, authz, { now: () => NOW });

    await service.downlineReports(ACTOR);

    expect(db.scopeFragmentOf("downline-reports")).toBeNull();
  });
});

describe("validateWeeklyReportInput", () => {
  it("returns trimmed visitors and note", () => {
    const result = validateWeeklyReportInput(baseInput({ visitors: [" Juan "], note: "  hola  " }));

    expect(result.visitors).toEqual(["Juan"]);
    expect(result.note).toBe("hola");
  });
});
