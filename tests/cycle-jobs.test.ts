import { describe, expect, it } from "vitest";

import { executeJob, isExclusionViolation, type JobDb } from "@/jobs/execute";

/**
 * The two cycle jobs are the first code that writes payment cycles and
 * obligations on a schedule, so their SQL is asserted directly: a fake raw
 * client routes on the same `/* @job:... *\/` markers the production
 * statements carry (the pattern tests/network.test.ts established). What must
 * hold: the planned windows are contiguous, inserts are guarded so a second
 * run is a no-op, the amount crosses into NUMERIC(14,2) as a DECIMAL string,
 * and the exempt_root guard is honoured.
 */

const MARKER = /\/\* (@job:[\w:-]+) \*\//;

interface Recorded {
  marker: string;
  sql: string;
  values: unknown[];
}

class JobFake implements JobDb {
  readonly execCalls: Recorded[] = [];
  readonly queryCalls: Recorded[] = [];
  /** One result per `$executeRaw` call, in order: a count, or an Error to throw. */
  execResults: Array<number | Error> = [];
  cycles: Array<{ id: string; periodKey: string }> = [];

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join("");
    this.execCalls.push({ marker: MARKER.exec(sql)?.[1] ?? "unknown", sql, values });
    const next = this.execResults.shift() ?? 0;
    if (next instanceof Error) throw next;
    return next;
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const sql = strings.join("");
    const marker = MARKER.exec(sql)?.[1] ?? "unknown";
    this.queryCalls.push({ marker, sql, values });
    if (marker === "@job:obligation-cycles") return this.cycles as T;
    throw new Error(`Unrouted query in the job fake: ${sql}`);
  }
}

const SETTINGS: Record<string, unknown> = {
  "general.timezone": "UTC",
  "payments.week_start_day": 1,
  "payments.grace_hours": 48,
  "payments.frequency": "WEEKLY",
  "payments.expected_amount": 10,
  "payments.exempt_root": true,
};

function fakeSettings(overrides: Record<string, unknown> = {}) {
  const entries = { ...SETTINGS, ...overrides };
  return {
    getOrThrow: <T>(key: string): Promise<T> => {
      if (!(key in entries)) return Promise.reject(new Error(`missing setting ${key}`));
      return Promise.resolve(entries[key] as T);
    },
  };
}

/** Thursday 2026-10-15 12:00 UTC — the week that opens Monday 2026-10-12 (W42). */
const NOW = new Date("2026-10-15T12:00:00.000Z");

function context(db: JobFake, overrides?: Record<string, unknown>) {
  return { db, settings: fakeSettings(overrides), now: NOW };
}

function exclusionViolation(): Error {
  return Object.assign(new Error("conflicting key value violates exclusion constraint"), {
    meta: { code: "23P01" },
  });
}

describe("cycle:ensure", () => {
  it("plans the current window plus the next four, contiguously", async () => {
    const db = new JobFake();
    const summary = await executeJob("cycle:ensure", context(db));

    expect(summary.planned).toBe(5);
    expect(summary.periodKeys).toEqual(["2026-W42", "2026-W43", "2026-W44", "2026-W45", "2026-W46"]);
    expect(db.execCalls).toHaveLength(5);

    // The first window: Monday 00:00 local (UTC here) to the next Monday, with
    // due_at = ends_at + payments.grace_hours. The guard re-binds period key
    // and range, so the same window appears twice in the parameter list.
    expect(db.execCalls[0].values).toEqual([
      "2026-W42",
      new Date("2026-10-12T00:00:00.000Z"),
      new Date("2026-10-19T00:00:00.000Z"),
      new Date("2026-10-21T00:00:00.000Z"),
      "2026-W42",
      new Date("2026-10-12T00:00:00.000Z"),
      new Date("2026-10-19T00:00:00.000Z"),
    ]);

    // Contiguity is what keeps the cycle without a gap: each window starts
    // exactly where the previous one ended.
    for (let index = 1; index < db.execCalls.length; index += 1) {
      expect(db.execCalls[index].values[1]).toEqual(db.execCalls[index - 1].values[2]);
    }
  });

  it("guards every insert against existing keys and overlapping windows", async () => {
    const db = new JobFake();
    await executeJob("cycle:ensure", context(db));

    for (const call of db.execCalls) {
      expect(call.marker).toBe("@job:cycle-insert");
      expect(call.sql).toContain("WHERE NOT EXISTS");
      expect(call.sql).toContain("tstzrange(c.starts_at, c.ends_at) && tstzrange(");
      expect(call.sql).toContain("ON CONFLICT (period_key) DO NOTHING");
    }
  });

  it("counts created, skipped and raced windows and tolerates a lost race", async () => {
    const db = new JobFake();
    db.execResults = [1, 0, exclusionViolation(), 1, 0];

    const summary = await executeJob("cycle:ensure", context(db));

    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(2);
    expect(summary.raced).toBe(1);
  });

  it("rethrows a database error that is not an exclusion violation", async () => {
    const db = new JobFake();
    db.execResults = [new Error("connection reset")];

    await expect(executeJob("cycle:ensure", context(db))).rejects.toThrow("connection reset");
  });
});

describe("isExclusionViolation", () => {
  it("reads the Prisma meta shape and the driver code shape", () => {
    expect(isExclusionViolation(exclusionViolation())).toBe(true);
    expect(isExclusionViolation(Object.assign(new Error("x"), { code: "23P01" }))).toBe(true);
    expect(isExclusionViolation(Object.assign(new Error("x"), { meta: { code: "23505" } }))).toBe(false);
    expect(isExclusionViolation(new Error("x"))).toBe(false);
    expect(isExclusionViolation("23P01")).toBe(false);
  });
});

describe("cycle:obligations", () => {
  it("inserts an obligation per ACTIVE user on every cycle that has not ended", async () => {
    const db = new JobFake();
    db.cycles = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", periodKey: "2026-W42" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", periodKey: "2026-W43" },
    ];
    db.execResults = [3, 0];

    const summary = await executeJob("cycle:obligations", context(db));

    expect(summary.cycles).toBe(2);
    expect(summary.inserted).toBe(3);
    expect(summary.expectedAmount).toBe("10.00");
    expect(summary.exemptRoot).toBe(true);

    const [query] = db.queryCalls;
    expect(query.marker).toBe("@job:obligation-cycles");
    expect(query.sql).toContain("WHERE ends_at >");
    expect(query.values).toEqual([NOW]);

    expect(db.execCalls).toHaveLength(2);
    expect(db.execCalls[0].values).toEqual(["aaaaaaaa-0000-0000-0000-000000000001", "10.00", true]);
    expect(db.execCalls[1].values).toEqual(["aaaaaaaa-0000-0000-0000-000000000002", "10.00", true]);

    for (const call of db.execCalls) {
      expect(call.marker).toBe("@job:obligation-insert");
      expect(call.sql).toContain("u.deleted_at IS NULL");
      expect(call.sql).toContain("u.status = 'ACTIVE'");
      expect(call.sql).toContain("u.role <> 'ROOT'");
      expect(call.sql).toContain("ON CONFLICT (cycle_id, user_id) DO NOTHING");
    }
  });

  it("writes the amount as a DECIMAL string, never as a float", async () => {
    const db = new JobFake();
    db.cycles = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", periodKey: "2026-W42" }];

    await executeJob("cycle:obligations", context(db, { "payments.expected_amount": 10.5 }));

    expect(db.execCalls[0].values[1]).toBe("10.50");
  });

  it("passes the exempt_root guard through as a bound parameter", async () => {
    const db = new JobFake();
    db.cycles = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", periodKey: "2026-W42" }];

    await executeJob("cycle:obligations", context(db, { "payments.exempt_root": false }));

    expect(db.execCalls[0].values[2]).toBe(false);
    expect(db.execCalls[0].sql).toContain("OR u.role <> 'ROOT'");
  });

  it("does nothing, query included, when no cycle is open", async () => {
    const db = new JobFake();
    db.cycles = [];

    const summary = await executeJob("cycle:obligations", context(db));

    expect(summary).toEqual({ cycles: 0, inserted: 0, expectedAmount: "10.00", exemptRoot: true });
    expect(db.execCalls).toHaveLength(0);
  });
});

describe("executeJob", () => {
  it("refuses a name the registry would never dispatch to it", async () => {
    const db = new JobFake();
    await expect(executeJob("cycle:reminders", context(db))).rejects.toThrow(
      /No runner registered for job "cycle:reminders"/,
    );
  });
});
