import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_PRESET_SCALE,
  DEMO_PRESET_SPEC,
  demoTreeSize,
  firstMemberIndexOfLevel,
  mulberry32,
  parseDemoArgs,
  seedDemo,
  type DemoOptions,
} from "../prisma/seed-demo";

/**
 * `seed:demo` without a database.
 *
 * `seedDemo(client, options, log)` takes its Prisma client and its logger as
 * parameters, so a fake that records the SQL it is handed stands in — the same
 * pattern as tests/seed.test.ts. The fake also simulates the parts of the
 * dataset the seed reads back: the root lookup, the per-level id read-back and
 * the member list the report generator walks.
 *
 * What is pinned here:
 *   * the safety rails (production refusal, non-demo refusal, --force),
 *   * the argument grammar and the tree maths (12³ → 1,885),
 *   * the shape of one full run: root + every level + past cycles + one
 *     obligations/reports batch per cycle + the MV refresh,
 *   * idempotency: a re-run skips report generation entirely,
 *   * determinism: mulberry32 makes the dataset reproducible.
 *
 * What is NOT pinned here (needs the real database): trigger-derived
 * path/depth, citext/ltree casts, jsonb_to_recordset column matching. The live
 * run against the dev DB is the integration proof.
 */

interface Recorded {
  kind: "query" | "execute";
  sql: string;
  values: unknown[];
}

class DemoFake {
  readonly statements: Recorded[] = [];
  rootExists = false;
  foreign = 0;
  reportsExist = 0;
  /** Demo members already in the database before the run. */
  demoUsers = 0;
  /** false simulates ON CONFLICT DO NOTHING swallowing every level insert. */
  membersInserted = true;
  readonly breadth: number;
  readonly depth: number;
  private levelReads = 0;
  private cycleSeq = 0;

  constructor(breadth = 2, depth = 2) {
    this.breadth = breadth;
    this.depth = depth;
  }

  private record(kind: Recorded["kind"]) {
    return (strings: TemplateStringsArray, ...values: unknown[]): void => {
      this.statements.push({ kind, sql: strings.join("?"), values });
    };
  }

  $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    this.record("query")(strings, ...values);
    const sql = strings.join(" ");

    // Order matters: the guard query also mentions sponsor_id IS NULL.
    if (/AS foreign/.test(sql)) return Promise.resolve([{ demo: 0, foreign: this.foreign }]);
    if (/COUNT\(\*\)::int AS n FROM users/.test(sql)) return Promise.resolve([{ n: this.demoUsers }]);
    if (/COUNT\(\*\)::int AS n/.test(sql)) return Promise.resolve([{ n: this.reportsExist }]);
    if (/sponsor_id IS NULL/.test(sql)) {
      return Promise.resolve(this.rootExists ? [{ id: "root-uuid", email: "root@example.com" }] : []);
    }
    if (/INSERT INTO users/.test(sql)) {
      if (this.rootExists) return Promise.resolve([]);
      this.rootExists = true;
      return Promise.resolve([{ id: "root-uuid" }]);
    }
    if (/SELECT id FROM users WHERE email::text = ANY/.test(sql)) {
      this.levelReads += 1;
      const size = this.breadth ** this.levelReads;
      return Promise.resolve(
        Array.from({ length: size }, (_, index) => ({ id: `level${this.levelReads}-member-${index}` })),
      );
    }
    if (/SELECT id, email::text AS email, path::text AS path, depth/.test(sql)) {
      const members: Array<{ id: string; email: string; path: string; depth: number }> = [];
      let index = 0;
      for (let level = 1; level <= this.depth; level += 1) {
        for (let n = 0; n < this.breadth ** level; n += 1) {
          index += 1;
          members.push({
            id: `member-${index}`,
            email: `miembro-${String(index).padStart(4, "0")}@demo.local`,
            path: `root.${index}`,
            depth: level,
          });
        }
      }
      return Promise.resolve(members);
    }
    if (/FROM payment_methods WHERE is_active/.test(sql)) {
      return Promise.resolve(
        ["TRANSFER", "MOBILE", "ZELLE", "CASH", "CRYPTO", "OTHER"].map((code, index) => ({
          code,
          id: `method-${index}`,
        })),
      );
    }
    if (/SELECT key, value FROM settings/.test(sql)) {
      return Promise.resolve([
        { key: "general.timezone", value: "America/Caracas" },
        { key: "payments.week_start_day", value: 1 },
        { key: "payments.grace_hours", value: 48 },
        { key: "payments.frequency", value: "WEEKLY" },
        { key: "payments.expected_amount", value: 10 },
        { key: "payments.currency", value: "USD" },
      ]);
    }
    if (/INSERT INTO payment_cycles/.test(sql)) {
      this.cycleSeq += 1;
      return Promise.resolve([{ id: `cycle-${this.cycleSeq}` }]);
    }
    if (/SELECT id FROM payment_cycles WHERE period_key/.test(sql)) {
      return Promise.resolve([{ id: `cycle-${this.cycleSeq}` }]);
    }
    return Promise.resolve([]);
  };

  $executeRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
    this.record("execute")(strings, ...values);
    const sql = strings.join(" ");
    if (/INSERT INTO users/.test(sql) && this.membersInserted) {
      const json = values.find((value) => typeof value === "string" && value.startsWith("["));
      if (typeof json === "string") this.demoUsers += (JSON.parse(json) as unknown[]).length;
    }
    return Promise.resolve(1);
  };

  $disconnect = (): Promise<void> => Promise.resolve();

  insertsInto(table: string): Recorded[] {
    return this.statements.filter((s) => new RegExp(`INSERT INTO ${table}\\b`).test(s.sql));
  }

  refreshesMv(): boolean {
    return this.statements.some((s) => /REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_weekly/.test(s.sql));
  }
}

const small: DemoOptions = { breadth: 2, depth: 2, weeks: 2, force: false };

async function run(db: DemoFake, options: DemoOptions = small): Promise<string[]> {
  const lines: string[] = [];
  await seedDemo(db as never, options, (message) => lines.push(message));
  return lines;
}

/** The JSON payload of the N-th `INSERT INTO <table>` statement. */
function payloadOf(db: DemoFake, table: string, index = 0): unknown[] {
  const statement = db.insertsInto(table)[index];
  const json = statement.values.find((value) => typeof value === "string" && value.startsWith("["));
  if (typeof json !== "string") throw new Error(`no JSON payload in ${table} insert`);
  return JSON.parse(json) as unknown[];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seed:demo — argument grammar", () => {
  it("defaults to the spec example (12 × 3 × 8, no force)", () => {
    expect(parseDemoArgs([])).toEqual({ ...DEMO_PRESET_SPEC, force: false });
  });

  it("applies --preset=scale (6 × 4 → 1,555 users, 5 levels)", () => {
    expect(parseDemoArgs(["--preset=scale"])).toEqual({ ...DEMO_PRESET_SCALE, force: false });
  });

  it("lets an explicit flag override the preset in any order", () => {
    expect(parseDemoArgs(["--preset=scale", "--breadth=3"]).breadth).toBe(3);
    expect(parseDemoArgs(["--breadth=3", "--preset=scale"]).breadth).toBe(3);
    expect(parseDemoArgs(["--preset=scale"]).depth).toBe(4);
  });

  it("parses the documented command literally", () => {
    expect(parseDemoArgs(["--breadth=12", "--depth=3", "--weeks=8"])).toEqual({
      breadth: 12,
      depth: 3,
      weeks: 8,
      force: false,
    });
  });

  it("accepts --force", () => {
    expect(parseDemoArgs(["--force"]).force).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseDemoArgs(["--tree=2"])).toThrow(/Unknown argument/);
    expect(() => parseDemoArgs(["--breadth=12.5"])).toThrow(/Unknown argument/);
  });

  it("rejects out-of-range values with the range in the message", () => {
    expect(() => parseDemoArgs(["--breadth=0"])).toThrow(/between 1 and 50/);
    expect(() => parseDemoArgs(["--breadth=51"])).toThrow(/between 1 and 50/);
    expect(() => parseDemoArgs(["--depth=7"])).toThrow(/between 0 and 6/);
    expect(() => parseDemoArgs(["--weeks=0"])).toThrow(/between 1 and 52/);
    expect(() => parseDemoArgs(["--weeks=53"])).toThrow(/between 1 and 52/);
  });
});

describe("seed:demo — tree maths", () => {
  it("12 × 3 is the spec's 1,885 users", () => {
    expect(demoTreeSize(12, 3)).toBe(1885);
  });

  it("6 × 4 is the A5 scale scenario: 1,555 users across 5 levels", () => {
    expect(demoTreeSize(6, 4)).toBe(1555);
  });

  it("handles the degenerate shapes", () => {
    expect(demoTreeSize(12, 0)).toBe(1);
    expect(demoTreeSize(1, 3)).toBe(4);
  });

  it("finds the first member of each level (breadth-first order)", () => {
    expect(firstMemberIndexOfLevel(12, 1)).toBe(1);
    expect(firstMemberIndexOfLevel(12, 2)).toBe(13);
    expect(firstMemberIndexOfLevel(12, 3)).toBe(157);
    expect(firstMemberIndexOfLevel(6, 2)).toBe(7);
    expect(firstMemberIndexOfLevel(6, 4)).toBe(259);
  });
});

describe("seed:demo — determinism", () => {
  it("mulberry32 replays the same sequence for the same seed", () => {
    const a = mulberry32(20261016);
    const b = mulberry32(20261016);
    const sequenceA = Array.from({ length: 32 }, () => a());
    const sequenceB = Array.from({ length: 32 }, () => b());
    expect(sequenceA).toEqual(sequenceB);
    for (const value of sequenceA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("a different seed diverges", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("seed:demo — safety rails", () => {
  it("refuses to run with NODE_ENV=production, with no override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const db = new DemoFake();
    await expect(run(db)).rejects.toThrow(/production/);
    expect(db.statements).toHaveLength(0);
  });

  it("refuses when non-demo accounts besides the root exist", async () => {
    const db = new DemoFake();
    db.foreign = 3;
    await expect(run(db)).rejects.toThrow(/3 non-demo accounts/);
  });

  it("--force is the only way past that refusal", async () => {
    const db = new DemoFake();
    db.foreign = 3;
    await expect(run(db, { ...small, force: true })).resolves.toBeDefined();
  });
});

describe("seed:demo — one full run", () => {
  it("creates the root, every level, the current cycle, the past cycles, obligations, reports and the MV refresh", async () => {
    const db = new DemoFake();
    const lines = await run(db);

    // Root (1 INSERT) + one bulk INSERT per level (2 levels here).
    expect(db.insertsInto("users")).toHaveLength(3);
    expect(db.insertsInto("users")[0].sql).toMatch(/INSERT INTO users/);
    expect(db.insertsInto("users")[1].sql).toMatch(/jsonb_to_recordset/);

    // 1 current cycle (from seedCurrentCycle) + 2 past ones.
    expect(db.insertsInto("payment_cycles")).toHaveLength(3);
    const closed = db
      .insertsInto("payment_cycles")
      .filter((statement) => /'CLOSED'/.test(statement.sql));
    expect(closed).toHaveLength(2);

    // One obligations batch and one reports batch per past cycle.
    expect(db.insertsInto("cycle_obligations")).toHaveLength(2);
    expect(db.insertsInto("payment_reports")).toHaveLength(2);

    // FK order: cycle_obligations.fulfilled_report_id REFERENCES
    // payment_reports(id), so every report INSERT must precede the obligation
    // batch that may point at it (a real 23503 was observed when reversed).
    const firstReports = db.statements.findIndex((s) => /INSERT INTO payment_reports/.test(s.sql));
    const firstObligations = db.statements.findIndex((s) => /INSERT INTO cycle_obligations/.test(s.sql));
    expect(firstReports).toBeGreaterThan(-1);
    expect(firstObligations).toBeGreaterThan(firstReports);

    // Every member of the 2 × 2 tree owes something in each past cycle.
    for (let index = 0; index < 2; index += 1) {
      expect(payloadOf(db, "cycle_obligations", index)).toHaveLength(6);
    }

    expect(db.refreshesMv()).toBe(true);

    const output = lines.join("\n");
    expect(output).toMatch(/7 users/);
    expect(output).toMatch(/LEVEL 1 {3}miembro-0001@demo\.local \/ [0-9A-Z]{16}/);
    expect(output).toMatch(/LEVEL 2 {3}miembro-0003@demo\.local/);
    expect(output).not.toMatch(/LEVEL 3/);
  });

  it("keeps reports and obligations consistent: FULFILLED ⇔ APPROVED ⇔ reviewed by the root", async () => {
    const db = new DemoFake();
    await run(db);

    for (let index = 0; index < 2; index += 1) {
      const reports = payloadOf(db, "payment_reports", index) as Array<Record<string, unknown>>;
      const obligations = payloadOf(db, "cycle_obligations", index) as Array<Record<string, unknown>>;

      for (const report of reports) {
        expect(["APPROVED", "PENDING", "REJECTED"]).toContain(report.status);
        expect(String(report.amount)).toMatch(/^\d+\.\d{2}$/);
        if (report.status === "APPROVED" || report.status === "REJECTED") {
          expect(report.reviewed_by).toBe("root-uuid");
          expect(report.reviewed_at).not.toBeNull();
        } else {
          expect(report.reviewed_by).toBeNull();
        }
        if (report.status === "REJECTED") expect(report.review_note).not.toBeNull();
      }

      const approved = reports.filter((report) => report.status === "APPROVED");
      const fulfilled = obligations.filter((obligation) => obligation.status === "FULFILLED");
      expect(fulfilled).toHaveLength(approved.length);
      for (const obligation of obligations) {
        expect(["FULFILLED", "PENDING", "MISSED"]).toContain(obligation.status);
        expect(obligation.expected).toBe("10.00");
        if (obligation.status === "FULFILLED") expect(obligation.report_id).not.toBeNull();
        else expect(obligation.report_id).toBeNull();
      }
    }
  });

  it("writes a files row for every receipt it references, and no more", async () => {
    const db = new DemoFake();
    await run(db);

    const withProof = [0, 1].flatMap((index) =>
      (payloadOf(db, "payment_reports", index) as Array<Record<string, unknown>>).filter(
        (report) => report.proof_key !== null,
      ),
    );
    // One files INSERT per cycle that produced receipts, never more rows than
    // referenced proof keys.
    const fileInserts = db.insertsInto("files");
    const fileRows = fileInserts.flatMap((_, index) => payloadOf(db, "files", index));
    if (withProof.length === 0) {
      expect(fileInserts).toHaveLength(0);
    } else {
      expect(fileInserts.length).toBeGreaterThan(0);
      expect(fileRows).toHaveLength(withProof.length);
      for (const report of withProof) {
        expect(String(report.proof_key)).toMatch(/^demo\/proofs\/[0-9a-f-]{36}\.jpg$/);
      }
    }
  });

  it("prints root credentials once the root is created, and shares one member password", async () => {
    const db = new DemoFake();
    const lines = await run(db);
    const output = lines.join("\n");

    const rootLine = /ROOT {6}root@demo\.local \/ ([0-9A-Z]{16})/.exec(output);
    expect(rootLine).not.toBeNull();
    const memberPasswords = [...output.matchAll(/miembro-\d{4}@demo\.local \/ ([0-9A-Z]{16})/g)].map(
      (match) => match[1],
    );
    expect(memberPasswords).toHaveLength(2);
    expect(new Set(memberPasswords).size).toBe(1);
    // Root and members never share a password.
    expect(memberPasswords[0]).not.toBe(rootLine?.[1]);
  });

  it("reuses a pre-existing root and says so instead of inventing a password", async () => {
    const db = new DemoFake();
    db.rootExists = true;
    const lines = await run(db);

    // Only the two per-level bulk inserts; no root INSERT.
    expect(db.insertsInto("users")).toHaveLength(2);
    const output = lines.join("\n");
    expect(output).toMatch(/pre-existing/);
    expect(output).not.toMatch(/ROOT {6}root@demo\.local \//);
  });

  it("models ~85% compliance on the member (the headline KPI), with the status mix in the tail", async () => {
    const db = new DemoFake(10, 2);
    await run(db, { breadth: 10, depth: 2, weeks: 1, force: false });

    const obligations = payloadOf(db, "cycle_obligations", 0) as Array<Record<string, unknown>>;
    const reports = payloadOf(db, "payment_reports", 0) as Array<Record<string, unknown>>;
    expect(obligations).toHaveLength(110);

    // 110 members, p = 0.85. The draw is deterministic (fixed seed); the band
    // is deliberately wide because what matters is the KPI MEANING — fulfilled
    // obligations near 85% — not the exact number of this particular draw.
    const fulfilled = obligations.filter((obligation) => obligation.status === "FULFILLED").length;
    expect(fulfilled).toBeGreaterThanOrEqual(Math.floor(110 * 0.78));
    expect(fulfilled).toBeLessThanOrEqual(Math.ceil(110 * 0.92));

    // The spec's status mix lives in the non-compliant tail and must be present.
    const pending = reports.filter((report) => report.status === "PENDING").length;
    const rejected = reports.filter((report) => report.status === "REJECTED").length;
    expect(pending).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(reports.filter((report) => report.status === "APPROVED")).toHaveLength(fulfilled);
  });

  it("expresses every write as ON CONFLICT DO NOTHING", async () => {
    const db = new DemoFake();
    await run(db);

    const conflictClause = /ON CONFLICT\s*(?:\([^)]*\))?\s+DO NOTHING/;
    const inserts = ["users", "payment_cycles", "cycle_obligations", "payment_reports", "files"].flatMap(
      (table) => db.insertsInto(table),
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const statement of inserts) {
      expect(conflictClause.test(statement.sql), statement.sql.slice(0, 80)).toBe(true);
    }
  });
});

describe("seed:demo — idempotency", () => {
  it("a re-run with the members already present does not print a password that would not work", async () => {
    const db = new DemoFake();
    db.rootExists = true;
    db.demoUsers = 6;
    db.membersInserted = false;
    const lines = await run(db);

    const output = lines.join("\n");
    expect(output).toMatch(/MEMBERS {3}already existed/);
    expect(output).not.toMatch(/LEVEL 1 {3}/);
  });

  it("skips report generation entirely when demo reports already exist", async () => {
    const db = new DemoFake();
    db.reportsExist = 12;
    const lines = await run(db);

    expect(db.insertsInto("payment_reports")).toHaveLength(0);
    expect(db.insertsInto("cycle_obligations")).toHaveLength(0);
    expect(db.insertsInto("files")).toHaveLength(0);
    // The surrounding scaffolding is still ensured.
    expect(db.insertsInto("payment_cycles")).toHaveLength(3);
    expect(db.refreshesMv()).toBe(true);
    expect(lines.join("\n")).toMatch(/already present/);
  });
});
