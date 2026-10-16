import { describe, expect, it } from "vitest";

import {
  executeJob,
  isExclusionViolation,
  matchesReminderDay,
  type JobContext,
  type JobDb,
  type JobTx,
} from "@/jobs/execute";

/**
 * The cycle jobs are the first code that writes payment cycles, obligations
 * and reminders on a schedule, so their SQL is asserted directly: a fake raw
 * client routes on the same `/* @job:... *\/` markers the production
 * statements carry (the pattern tests/network.test.ts established). What must
 * hold: the planned windows are contiguous, inserts are guarded so a second
 * run is a no-op, the amount crosses into NUMERIC(14,2) as a DECIMAL string,
 * the exempt_root guard is honoured, reminders fire only on the configured
 * local days and never twice per person/cycle/day, and the multi-statement
 * job holds the advisory lock while the guard-only jobs stay in autocommit.
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
  reminderCycles: Array<{ id: string; periodKey: string; dueAt: Date }> = [];
  closeCycles: Array<{ id: string; periodKey: string; dueAt: Date }> = [];
  suspendRows: Array<{ id: string; missedCount: number }> = [];
  /** One problems list per `@job:tree-problems` call: before, then after repair. */
  treeProblemRounds: Array<Array<{ userId: string; publicCode: string; reason: string }>> = [];
  repairResult: Array<{ fixed: number }> = [{ fixed: 0 }];
  /** Orphans the `files:gc` candidate query returns. */
  filesCandidates: Array<{ id: string; key: string }> = [];
  /** What `pg_try_advisory_xact_lock` reports; false = a concurrent run holds it. */
  lockAvailable = true;

  async $transaction<T>(fn: (tx: JobTx) => Promise<T>): Promise<T> {
    return fn(this);
  }

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
    if (marker === "@job:lock") return [{ locked: this.lockAvailable }] as T;
    if (marker === "@job:obligation-cycles") return this.cycles as T;
    if (marker === "@job:reminder-cycles") return this.reminderCycles as T;
    if (marker === "@job:close-cycles") return this.closeCycles as T;
    if (marker === "@job:close-suspend") return this.suspendRows as T;
    if (marker === "@job:tree-problems") return (this.treeProblemRounds.shift() ?? []) as T;
    if (marker === "@job:tree-rebuild") return this.repairResult as T;
    if (marker === "@job:files-gc-candidates") return this.filesCandidates as T;
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
  "payments.reminder_days_before_due": [1],
  "payments.auto_suspend_on_strikes": false,
  "payments.missed_grace_strikes": 3,
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

function context(db: JobFake, overrides?: Record<string, unknown>, extra: Partial<JobContext> = {}) {
  return { db, settings: fakeSettings(overrides), now: NOW, ...extra };
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

describe("cycle:reminders", () => {
  /** due_at tomorrow (UTC): exactly one day ahead — the default [1] matches. */
  const SOON = {
    id: "bbbbbbbb-0000-0000-0000-000000000001",
    periodKey: "2026-W42",
    dueAt: new Date("2026-10-16T12:00:00.000Z"),
  };
  /** due_at five days ahead: no configured day matches. */
  const LATER = {
    id: "bbbbbbbb-0000-0000-0000-000000000002",
    periodKey: "2026-W43",
    dueAt: new Date("2026-10-20T12:00:00.000Z"),
  };

  it("notifies only on a reminder day, once per person, cycle and local day", async () => {
    const db = new JobFake();
    db.reminderCycles = [SOON, LATER];
    db.execResults = [3];

    const summary = await executeJob("cycle:reminders", context(db));

    expect(summary).toEqual({ candidates: 2, cycles: 1, notified: 3, reminderDays: [1] });

    // The lock comes FIRST: the candidate read and every insert live in the
    // same transaction that holds it, so a concurrent run cannot interleave.
    expect(db.queryCalls.map((call) => call.marker)).toEqual([
      "@job:lock",
      "@job:reminder-cycles",
    ]);
    expect(db.queryCalls[0].sql).toContain("pg_try_advisory_xact_lock(hashtext(");
    expect(db.queryCalls[0].values).toEqual(["job:cycle:reminders"]);

    const [candidates] = db.queryCalls.slice(1);
    expect(candidates.sql).toContain("status <> 'CLOSED'");
    expect(candidates.sql).toContain("due_at >");
    expect(candidates.sql).toContain("o.status = 'PENDING'");
    expect(candidates.values).toEqual([NOW]);

    expect(db.execCalls).toHaveLength(1);
    const [insert] = db.execCalls;
    expect(insert.marker).toBe("@job:reminder-insert");
    // The parameters pin the whole dedup key: the audience filters, the
    // cycleId stored in `data`, and the local date the row was created on.
    expect(insert.values).toEqual([
      "Aporte pendiente",
      "No registramos tu aporte de la semana 2026-W42. Envíalo antes del vencimiento para mantener tu cumplimiento.",
      SOON.id,
      "2026-W42",
      SOON.id,
      SOON.id,
      "UTC",
      "2026-10-15",
    ]);
    expect(insert.sql).toContain("u.deleted_at IS NULL");
    expect(insert.sql).toContain("u.status = 'ACTIVE'");
    expect(insert.sql).toContain("pr.status <> 'REJECTED'");
    expect(insert.sql).toContain("n.type = 'cycle.reminder'");
    expect(insert.sql).toContain("n.data->>'cycleId' = ");
    expect(insert.sql).toContain("AT TIME ZONE");
    expect(insert.sql).toContain("jsonb_build_object('cycleId'");
  });

  it("skips the whole run when another instance already holds the lock", async () => {
    const db = new JobFake();
    db.reminderCycles = [SOON];
    db.lockAvailable = false;

    const summary = await executeJob("cycle:reminders", context(db));

    expect(summary).toEqual({ skipped: true, reason: "LOCK_BUSY" });
    expect(db.queryCalls).toHaveLength(1); // the lock attempt itself
    expect(db.execCalls).toHaveLength(0);
  });

  it("inserts nothing when today is not a reminder day", async () => {
    const db = new JobFake();
    db.reminderCycles = [LATER];

    const summary = await executeJob("cycle:reminders", context(db));

    expect(summary).toEqual({ candidates: 1, cycles: 0, notified: 0, reminderDays: [1] });
    expect(db.execCalls).toHaveLength(0);
  });

  it("treats an empty reminder list as no reminder days", async () => {
    const db = new JobFake();
    db.reminderCycles = [SOON];

    const summary = await executeJob(
      "cycle:reminders",
      context(db, { "payments.reminder_days_before_due": [] }),
    );

    expect(summary).toEqual({ candidates: 1, cycles: 0, notified: 0, reminderDays: [] });
    expect(db.execCalls).toHaveLength(0);
  });

  it("leaves the guard-only jobs in autocommit, without the lock", async () => {
    // Deliberate: a 23P01 caught inside an open transaction would leave it
    // aborted, and cycle:ensure's race tolerance depends on autocommit.
    const ensure = new JobFake();
    await executeJob("cycle:ensure", context(ensure));
    expect(ensure.queryCalls.filter((call) => call.marker === "@job:lock")).toHaveLength(0);

    const obligations = new JobFake();
    obligations.cycles = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", periodKey: "2026-W42" }];
    await executeJob("cycle:obligations", context(obligations));
    expect(obligations.queryCalls.map((call) => call.marker)).toEqual(["@job:obligation-cycles"]);
  });
});

describe("cycle:close", () => {
  const CYCLE_A = {
    id: "cccccccc-0000-0000-0000-000000000001",
    periodKey: "2026-W41",
    dueAt: new Date("2026-10-14T00:00:00.000Z"),
  };
  const CYCLE_B = {
    id: "cccccccc-0000-0000-0000-000000000002",
    periodKey: "2026-W42",
    dueAt: new Date("2026-10-14T12:00:00.000Z"),
  };

  it("marks PENDING obligations MISSED first, then closes each cycle past its grace", async () => {
    const db = new JobFake();
    db.closeCycles = [CYCLE_A, CYCLE_B];
    db.execResults = [2, 0, 1, 0];

    const summary = await executeJob("cycle:close", context(db));

    expect(summary).toEqual({ cycles: 2, missed: 3, suspended: 0, autoSuspend: false, threshold: 3 });

    // Locked job: the advisory lock is the first statement of the shared tx.
    expect(db.queryCalls[0].marker).toBe("@job:lock");
    expect(db.queryCalls[0].values).toEqual(["job:cycle:close"]);

    const [candidates] = db.queryCalls.slice(1);
    expect(candidates.marker).toBe("@job:close-cycles");
    expect(candidates.sql).toContain("status <> 'CLOSED'");
    expect(candidates.sql).toContain("due_at < ");
    expect(candidates.values).toEqual([NOW]);

    // Obligations go MISSED before their cycle closes, per cycle; the cycle
    // close only happens where it is not already CLOSED.
    expect(db.execCalls.map((call) => call.marker)).toEqual([
      "@job:close-missed",
      "@job:close-cycle",
      "@job:close-missed",
      "@job:close-cycle",
    ]);
    const [missA, closeA] = db.execCalls;
    expect(missA.sql).toContain("SET status = 'MISSED'");
    expect(missA.sql).toContain("status = 'PENDING'");
    expect(missA.values).toEqual([CYCLE_A.id]);
    expect(closeA.sql).toContain("SET status = 'CLOSED'");
    expect(closeA.sql).toContain("status <> 'CLOSED'");
    expect(closeA.values).toEqual([CYCLE_A.id]);
    expect(db.execCalls[2].values).toEqual([CYCLE_B.id]);

    // auto_suspend is off: no suspension query at all.
    expect(db.queryCalls.filter((call) => call.marker === "@job:close-suspend")).toHaveLength(0);
  });

  it("suspends ACTIVE users at the threshold when auto_suspend_on_strikes is on", async () => {
    const db = new JobFake();
    db.closeCycles = [CYCLE_A];
    db.execResults = [2, 0, 1, 1]; // missed, close, notify, audit
    db.suspendRows = [{ id: "dddddddd-0000-0000-0000-000000000001", missedCount: 3 }];

    const summary = await executeJob(
      "cycle:close",
      context(db, { "payments.auto_suspend_on_strikes": true }),
    );

    expect(summary).toEqual({ cycles: 1, missed: 2, suspended: 1, autoSuspend: true, threshold: 3 });

    const suspend = db.queryCalls.find((call) => call.marker === "@job:close-suspend");
    expect(suspend).toBeDefined();
    expect(suspend!.sql).toContain("SET status = 'SUSPENDED'");
    expect(suspend!.sql).toContain("u.status = 'ACTIVE'");
    expect(suspend!.sql).toContain("u.role <> 'ROOT'");
    expect(suspend!.sql).toContain("o.status = 'MISSED'");
    expect(suspend!.sql).toContain("RETURNING");
    // The array pins the cycles closed by THIS run; the threshold comes from
    // payments.missed_grace_strikes.
    expect(suspend!.values).toEqual([[CYCLE_A.id], 3]);

    expect(db.execCalls.map((call) => call.marker)).toEqual([
      "@job:close-missed",
      "@job:close-cycle",
      "@job:close-notify",
      "@job:close-audit",
    ]);

    const notify = db.execCalls[2];
    expect(notify.sql).toContain("'user.suspended'");
    expect(notify.values).toEqual([
      "dddddddd-0000-0000-0000-000000000001",
      "Cuenta suspendida",
      "No completaste tus aportes de varias semanas y tu cuenta quedó suspendida. Contacta a la administración para reactivarla.",
      3,
    ]);

    // The audit row has a NULL actor: this was the system, not a person.
    const audit = db.execCalls[3];
    expect(audit.sql).toContain("INSERT INTO audit_log");
    expect(audit.sql).toContain("NULL");
    expect(audit.values).toEqual([
      "dddddddd-0000-0000-0000-000000000001",
      JSON.stringify({ status: "ACTIVE" }),
      JSON.stringify({ status: "SUSPENDED", missedCount: 3, threshold: 3 }),
    ]);
  });

  it("does not check suspension when no cycle closed this run", async () => {
    const db = new JobFake();
    db.closeCycles = [];

    const summary = await executeJob(
      "cycle:close",
      context(db, { "payments.auto_suspend_on_strikes": true }),
    );

    expect(summary).toEqual({ cycles: 0, missed: 0, suspended: 0, autoSuspend: true, threshold: 3 });
    expect(db.execCalls).toHaveLength(0);
    expect(db.queryCalls.filter((call) => call.marker === "@job:close-suspend")).toHaveLength(0);
  });
});

describe("matchesReminderDay", () => {
  it("compares LOCAL dates, not UTC ones", () => {
    const now = new Date("2026-10-16T02:30:00.000Z"); // Oct 15 22:30 in Caracas
    const due = new Date("2026-10-16T12:00:00.000Z"); // Oct 16 08:00 in Caracas

    expect(matchesReminderDay(now, due, "America/Caracas", [1])).toBe(true);
    // The same instants are Oct 16 -> Oct 16 in UTC: zero days apart.
    expect(matchesReminderDay(now, due, "UTC", [1])).toBe(false);
  });

  it("checks membership against every configured day and rejects negatives", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const threeAhead = new Date("2026-10-18T12:00:00.000Z");
    const yesterday = new Date("2026-10-14T12:00:00.000Z");

    expect(matchesReminderDay(now, threeAhead, "UTC", [1, 3])).toBe(true);
    expect(matchesReminderDay(now, threeAhead, "UTC", [1, 2])).toBe(false);
    expect(matchesReminderDay(now, yesterday, "UTC", [0, 1])).toBe(false);
    expect(matchesReminderDay(now, threeAhead, "UTC", [])).toBe(false);
  });

  it("rejects an unknown timezone instead of guessing", () => {
    const at = new Date("2026-10-15T12:00:00.000Z");
    expect(() => matchesReminderDay(at, at, "Foo/Bar", [0])).toThrow(RangeError);
  });
});

describe("tree:verify", () => {
  const DIVERGENCE = {
    userId: "eeeeeeee-0000-0000-0000-000000000001",
    publicCode: "AB12",
    reason: "users.depth 2 <> expected 1; 1 closure edge(s) missing",
  };

  it("does nothing when the three structures already agree", async () => {
    const db = new JobFake();
    db.treeProblemRounds = [[]];

    const summary = await executeJob("tree:verify", context(db));

    expect(summary).toEqual({ problems: 0, repairedUsers: 0, remaining: 0, notified: 0 });
    expect(db.execCalls).toHaveLength(0);
    expect(db.queryCalls.map((call) => call.marker)).toEqual(["@job:lock", "@job:tree-problems"]);
    expect(db.queryCalls[0].values).toEqual(["job:tree:verify"]);

    const [problems] = db.queryCalls.slice(1);
    expect(problems.sql).toContain("WITH RECURSIVE walk");
    expect(problems.sql).toContain("fn_ltree_label");
    expect(problems.sql).toContain("user_closure");
    expect(problems.sql).toContain("generate_series");
    expect(problems.sql).toContain("'not reachable from the root via sponsor_id'");
    expect(problems.sql).toContain("closure edge(s) missing");
    expect(problems.sql).toContain("closure edge(s) stale");
    expect(problems.sql).toContain("closure edge(s) with wrong depth");
  });

  it("records the alert and repairs, then re-verifies inside the same transaction", async () => {
    const db = new JobFake();
    db.treeProblemRounds = [[DIVERGENCE], []];
    db.repairResult = [{ fixed: 2 }];
    db.execResults = [1, 3]; // audit row, staff notifications

    const summary = await executeJob("tree:verify", context(db));

    expect(summary).toEqual({ problems: 1, repairedUsers: 2, remaining: 0, notified: 3 });

    // Order matters: verify → rebuild → verify again, all under the lock.
    expect(db.queryCalls.map((call) => call.marker)).toEqual([
      "@job:lock",
      "@job:tree-problems",
      "@job:tree-rebuild",
      "@job:tree-problems",
    ]);
    expect(db.queryCalls[2].sql).toContain("fn_tree_rebuild()");

    expect(db.execCalls.map((call) => call.marker)).toEqual([
      "@job:tree-audit",
      "@job:tree-notify",
    ]);

    const [audit, notify] = db.execCalls;
    expect(audit.sql).toContain("INSERT INTO audit_log");
    expect(audit.sql).toContain("NULL");
    expect(audit.values).toEqual([
      JSON.stringify({ divergences: 1, problems: [DIVERGENCE] }),
      JSON.stringify({ repairedUsers: 2, remaining: 0 }),
    ]);

    expect(notify.sql).toContain("'tree.verify_alert'");
    expect(notify.sql).toContain("u.role IN ('ROOT', 'ADMIN')");
    expect(notify.sql).toContain("u.status = 'ACTIVE'");
    expect(notify.values).toEqual([
      "Árbol reconstruido",
      "tree:verify encontró 1 divergencia(s) y reconstruyó la estructura del árbol.",
      1,
      0,
    ]);
  });

  it("reports what the rebuild could not fix instead of pretending", async () => {
    const db = new JobFake();
    db.treeProblemRounds = [[DIVERGENCE], [DIVERGENCE]];
    db.repairResult = [{ fixed: 0 }];
    db.execResults = [1, 1];

    const summary = await executeJob("tree:verify", context(db));

    expect(summary).toEqual({ problems: 1, repairedUsers: 0, remaining: 1, notified: 1 });
    expect(db.execCalls[1].values).toContain(
      "tree:verify encontró 1 divergencia(s); tras reconstruir quedan 1 sin resolver (cadena de patrocinadores rota).",
    );
  });
});

describe("files:gc", () => {
  const ORPHAN_A = { id: "aaaaaaaa-0000-0000-0000-000000000001", key: "aaaaaaaa-0000-0000-0000-0000000000aa.jpg" };
  const ORPHAN_B = { id: "bbbbbbbb-0000-0000-0000-000000000002", key: "bbbbbbbb-0000-0000-0000-0000000000bb.pdf" };

  it("removes orphan objects, their rows, and old rate-limit windows", async () => {
    const db = new JobFake();
    db.filesCandidates = [ORPHAN_A, ORPHAN_B];
    db.execResults = [1, 1, 3, 1]; // two row deletes, the trim, the audit
    const removedKeys: string[] = [];

    const summary = await executeJob(
      "files:gc",
      context(db, undefined, {
        removeObject: async (key) => {
          removedKeys.push(key);
        },
      }),
    );

    expect(summary).toEqual({ candidates: 2, removed: 2, failed: 0, rateLimits: 3 });
    // Objects go first: the opposite order would leak them with no row left.
    expect(removedKeys).toEqual([ORPHAN_A.key, ORPHAN_B.key]);
    expect(db.execCalls.map((call) => call.marker)).toEqual([
      "@job:files-gc-delete",
      "@job:files-gc-delete",
      "@job:files-gc-rate-limits",
      "@job:files-gc-audit",
    ]);
    expect(db.execCalls[0].values).toEqual([ORPHAN_A.id]);
    expect(db.execCalls[3].values).toEqual([
      JSON.stringify({ candidates: 2 }),
      JSON.stringify({ removed: 2, failed: 0, rateLimits: 3 }),
    ]);
  });

  it("age-bounds, reference-guards and caps the candidate query", async () => {
    const db = new JobFake();
    db.filesCandidates = [ORPHAN_A];
    db.execResults = [1, 0, 1];

    await executeJob("files:gc", context(db));

    const [candidates] = db.queryCalls;
    expect(candidates.marker).toBe("@job:files-gc-candidates");
    expect(candidates.sql).toContain("interval '24 hours'");
    expect(candidates.sql).toContain("payment_reports");
    expect(candidates.sql).toContain("proof_key");
    expect(candidates.sql).toContain("avatar_key");
    expect(candidates.sql).toContain("general.logo_key");
    expect(candidates.sql).toContain("LIMIT 1000");
  });

  it("keeps the row when its object cannot be removed", async () => {
    const db = new JobFake();
    db.filesCandidates = [ORPHAN_A, ORPHAN_B];
    db.execResults = [1, 0, 1]; // only B's row is deleted; trim 0; audit

    const summary = await executeJob(
      "files:gc",
      context(db, undefined, {
        removeObject: async (key) => {
          if (key === ORPHAN_A.key) throw new Error("disk unavailable");
        },
      }),
    );

    expect(summary).toEqual({ candidates: 2, removed: 1, failed: 1, rateLimits: 0 });
    expect(db.execCalls.map((call) => call.marker)).toEqual([
      "@job:files-gc-delete",
      "@job:files-gc-rate-limits",
      "@job:files-gc-audit",
    ]);
    expect(db.execCalls[0].values).toEqual([ORPHAN_B.id]);
  });

  it("writes nothing at all when there is nothing to do", async () => {
    const db = new JobFake();
    db.execResults = [0]; // the trim deletes zero old windows

    const summary = await executeJob("files:gc", context(db));

    expect(summary).toEqual({ candidates: 0, removed: 0, failed: 0, rateLimits: 0 });
    expect(db.execCalls.map((call) => call.marker)).toEqual(["@job:files-gc-rate-limits"]);
    expect(db.execCalls[0].sql).toContain("interval '7 days'");
  });
});

describe("executeJob", () => {
  it("refuses a name the registry would never dispatch to it", async () => {
    const db = new JobFake();
    await expect(executeJob("cycle:missing", context(db))).rejects.toThrow(
      /No runner registered for job "cycle:missing"/,
    );
    expect(db.queryCalls).toHaveLength(0);
  });
});
