// =============================================================================
// tests/payments.test.ts — §5.5 payment reports service.
//
// The fake db routes by the `/* @pay:… */` marker embedded in every statement
// (same convention as NetFake), so these tests assert the actual SQL values:
// the formatted DECIMAL string, the snapshot copied from the author, the enum
// code projection, the status written, and WHEN the obligation is fulfilled.
// =============================================================================

import { describe, expect, it } from "vitest";

import { createAuthorization, type SessionActor } from "../lib/authz";
import {
  createPaymentsService,
  isUniqueViolation,
  type CreateReportInput,
  type PaymentsDb,
  type PaymentsSettings,
} from "../lib/payments";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ACTOR = { id: "user-1", role: "MEMBER" };
const REVIEWER = { id: "admin-1", role: "ADMIN" };

type Handler = (values: unknown[]) => unknown;

class PayFake implements PaymentsDb {
  readonly queries: Array<{ marker: string; text: string; values: unknown[] }> = [];
  readonly executions: Array<{ marker: string; values: unknown[] }> = [];
  private readonly queryHandlers = new Map<string, Handler>();
  private readonly execHandlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.queryHandlers.set(marker, handler);
    return this;
  }

  onExec(marker: string, handler: Handler): this {
    this.execHandlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; text: string; values: unknown[] }> {
    return this.queries.filter((call) => call.marker === marker);
  }

  execCallsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.executions.filter((call) => call.marker === marker);
  }

  valuesOf(marker: string): unknown[] {
    return this.callsFor(marker)[0]?.values ?? [];
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @pay:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`PayFake: unmarked statement: ${text}`);
    const handler = this.queryHandlers.get(marker);
    if (!handler) throw new Error(`PayFake: no handler for ${marker}`);
    this.queries.push({ marker, text, values });
    return (await handler(values)) as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = strings.join("?");
    const marker = /\/\* @pay:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`PayFake: unmarked statement: ${text}`);
    this.executions.push({ marker, values });
    const handler = this.execHandlers.get(marker);
    return handler ? (handler(values) as number) : 1;
  }
}

function makeSettings(overrides: Record<string, unknown> = {}): PaymentsSettings {
  const values: Record<string, unknown> = {
    "payments.amount_mode": "MINIMUM",
    "payments.expected_amount": 10,
    "payments.currency": "USD",
    "payments.allow_backdated_days": 7,
    "payments.auto_approve": false,
    "payments.require_proof": false,
    "payments.require_reference": true,
    "visibility.downline_depth_visible": 0,
    // D39 default: the downline amount stays hidden unless an admin enables it.
    "visibility.member_sees_downline_amounts": false,
    ...overrides,
  };
  return {
    async getOrThrow<T>(key: string): Promise<T> {
      if (!(key in values)) throw new Error(`test settings missing ${key}`);
      return values[key] as T;
    },
  };
}

/** The innermost non-empty Sql fragment embedded in a query's bind values. */
function sqlFragment(values: unknown[]): { sql: string; values: unknown[] } | null {
  for (const value of values) {
    if (value && typeof value === "object" && typeof (value as { sql?: unknown }).sql === "string") {
      const nested = sqlFragment(((value as { values?: unknown[] }).values ?? []) as unknown[]);
      if (nested) return nested;
      if ((value as { sql: string }).sql.trim() !== "") return value as { sql: string; values: unknown[] };
    }
  }
  return null;
}

const MY_ROW = {
  id: "report-1",
  amount: "10.00",
  currency: "USD",
  method: "TRANSFER",
  status: "PENDING" as const,
  paidAt: NOW,
  reportedAt: NOW,
  reviewNote: null,
  proofKey: null,
  cycleId: "cycle-1",
  periodKey: "2026-W42",
};

const QUEUE_ROW = {
  id: "report-1",
  amount: "10.00",
  currency: "USD",
  method: "TRANSFER",
  paidAt: NOW,
  reportedAt: NOW,
  note: null,
  proofKey: null,
  reference: "REF-1",
  userId: ACTOR.id,
  fullName: "Ana Pérez",
  publicCode: "ANA001",
  cycleId: "cycle-1",
  periodKey: "2026-W42",
};

function buildService(overrides: { settings?: Record<string, unknown>; now?: Date } = {}) {
  const db = new PayFake();
  const method = { id: "method-1", code: "TRANSFER", requires_reference: true, requires_proof: false };

  db.on("cycle-window", () => [
    {
      id: "cycle-1",
      period_key: "2026-W42",
      starts_at: new Date("2026-10-12T00:00:00.000Z"),
      ends_at: new Date("2026-10-19T00:00:00.000Z"),
      due_at: new Date("2026-10-21T00:00:00.000Z"),
    },
  ])
    .on("method", () => [method])
    .on("proof-owner", () => [{ owner_id: ACTOR.id }])
    .on("existing-report", () => [])
    .on("author-snapshot", () => [{ path: "root.abc", depth: 2 }])
    .on("insert-report", () => [{ id: "report-1", reported_at: NOW }])
    .on("report-for-review", () => [{ id: "report-1", user_id: ACTOR.id, cycle_id: "cycle-1", status: "PENDING" }])
    .on("review-update", () => [{ id: "report-1", user_id: ACTOR.id, cycle_id: "cycle-1" }])
    .on("my-reports", () => [MY_ROW])
    .on("review-queue", () => [QUEUE_ROW]);

  const settings = makeSettings(overrides.settings);
  const service = createPaymentsService(db, settings, createAuthorization(db, settings), { now: () => overrides.now ?? NOW });
  return { db, service, method };
}

function baseInput(overrides: Partial<CreateReportInput> = {}): CreateReportInput {
  return {
    amount: "10.00",
    methodId: "method-1",
    reference: "REF-1",
    paidAt: new Date("2026-10-15T10:00:00.000Z"),
    note: null,
    proofKey: null,
    ...overrides,
  };
}

describe("createReport", () => {
  it("inserts a PENDING report with the settings-driven DECIMAL, currency, enum and snapshot", async () => {
    const { db, service } = buildService();

    const result = await service.createReport(ACTOR, baseInput());

    expect(result).toEqual({ id: "report-1", status: "PENDING", cycleId: "cycle-1", periodKey: "2026-W42", reportedAt: NOW });
    const insertValues = db.valuesOf("insert-report");
    expect(insertValues).toContain(ACTOR.id);
    expect(insertValues).toContain("cycle-1");
    expect(insertValues).toContain("10.00");
    expect(insertValues).toContain("USD");
    expect(insertValues).toContain("TRANSFER");
    expect(insertValues).toContain("PENDING");
    expect(insertValues).toContain(2);
    expect(insertValues).toContain("root.abc");
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(0);
    expect(db.execCallsFor("notify-review")).toHaveLength(0);
  });

  it("rejects an amount below the MINIMUM", async () => {
    const { db, service } = buildService();

    await expect(service.createReport(ACTOR, baseInput({ amount: "9.99" }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { amount: expect.any(String) },
    });
    expect(db.callsFor("insert-report")).toHaveLength(0);
  });

  it("rejects a different amount under FIXED and accepts the exact one", async () => {
    const fixed = buildService({ settings: { "payments.amount_mode": "FIXED" } });

    await expect(fixed.service.createReport(ACTOR, baseInput({ amount: "12.00" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(fixed.service.createReport(ACTOR, baseInput({ amount: "10.00" }))).resolves.toMatchObject({ id: "report-1" });
  });

  it("accepts any positive amount under FREE", async () => {
    const { service } = buildService({ settings: { "payments.amount_mode": "FREE" } });

    await expect(service.createReport(ACTOR, baseInput({ amount: "0.01" }))).resolves.toMatchObject({ status: "PENDING" });
  });

  it("rejects zero and non-numeric amounts", async () => {
    const { service } = buildService({ settings: { "payments.amount_mode": "FREE" } });

    await expect(service.createReport(ACTOR, baseInput({ amount: "0" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.createReport(ACTOR, baseInput({ amount: "abc" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reports a conflict when no cycle is inside its report window", async () => {
    const { db, service } = buildService();
    db.on("cycle-window", () => []);

    await expect(service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ code: "NO_REPORT_WINDOW" });
  });

  it("reports a conflict when the member already has a live report for the cycle", async () => {
    const { db, service } = buildService();
    db.on("existing-report", () => [{ id: "report-0" }]);

    await expect(service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ code: "REPORT_ALREADY_EXISTS" });
    expect(db.callsFor("insert-report")).toHaveLength(0);
  });

  it("maps the partial unique index backstop (23505) to the same conflict", async () => {
    const { db, service } = buildService();
    db.on("insert-report", () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });

    await expect(service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ code: "REPORT_ALREADY_EXISTS" });
  });

  it("rejects a future paid_at", async () => {
    const { service } = buildService();

    await expect(service.createReport(ACTOR, baseInput({ paidAt: new Date("2026-10-16T00:00:00.000Z") }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { paidAt: expect.any(String) },
    });
  });

  it("bounds paid_at by allow_backdated_days", async () => {
    const { service } = buildService();

    await expect(service.createReport(ACTOR, baseInput({ paidAt: new Date("2026-10-08T12:00:00.000Z") }))).resolves.toMatchObject({ id: "report-1" });
    await expect(service.createReport(ACTOR, baseInput({ paidAt: new Date("2026-10-07T12:00:00.000Z") }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("requires a reference only when the setting AND the method flag agree", async () => {
    const { db, service, method } = buildService();

    await expect(service.createReport(ACTOR, baseInput({ reference: null }))).rejects.toMatchObject({
      details: { reference: expect.any(String) },
    });

    method.requires_reference = false;
    await expect(service.createReport(ACTOR, baseInput({ reference: null }))).resolves.toMatchObject({ id: "report-1" });

    method.requires_reference = true;
    const relaxed = buildService({ settings: { "payments.require_reference": false } });
    await expect(relaxed.service.createReport(ACTOR, baseInput({ reference: null }))).resolves.toMatchObject({ id: "report-1" });
    expect(db.valuesOf("insert-report")).toContain(null);
  });

  it("requires a proof when the global setting OR the method demands it", async () => {
    const globalProof = buildService({ settings: { "payments.require_proof": true } });
    await expect(globalProof.service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ details: { proof: expect.any(String) } });

    const methodProof = buildService();
    methodProof.method.requires_proof = true;
    await expect(methodProof.service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ details: { proof: expect.any(String) } });
  });

  it("only accepts a proof key uploaded by the reporter", async () => {
    const { db, service } = buildService();

    const result = await service.createReport(ACTOR, baseInput({ proofKey: "11111111-2222-3333-4444-555555555555.jpg" }));
    expect(result.id).toBe("report-1");
    expect(db.valuesOf("insert-report")).toContain("11111111-2222-3333-4444-555555555555.jpg");

    db.on("proof-owner", () => [{ owner_id: "someone-else" }]);
    await expect(service.createReport(ACTOR, baseInput({ proofKey: "11111111-2222-3333-4444-555555555555.jpg" }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { proof: expect.any(String) },
    });
  });

  it("rejects an unknown or inactive method", async () => {
    const { db, service } = buildService();
    db.on("method", () => []);

    await expect(service.createReport(ACTOR, baseInput())).rejects.toMatchObject({ details: { methodId: expect.any(String) } });
  });

  it("falls back to OTHER for admin-defined method codes outside the enum vocabulary", async () => {
    const { db, service, method } = buildService();
    method.code = "NEQUI";

    await service.createReport(ACTOR, baseInput());
    expect(db.valuesOf("insert-report")).toContain("OTHER");
  });

  it("auto-approves when payments.auto_approve is on, fulfilling the obligation at once", async () => {
    const { db, service } = buildService({ settings: { "payments.auto_approve": true } });

    const result = await service.createReport(ACTOR, baseInput());

    expect(result.status).toBe("APPROVED");
    expect(db.valuesOf("insert-report")).toContain("APPROVED");
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(1);
    expect(db.execCallsFor("notify-review")).toHaveLength(1);
  });
});

describe("reviewReport", () => {
  it("rejects reviewers who are not ADMIN or ROOT", async () => {
    const { service } = buildService();

    await expect(service.reviewReport(ACTOR, "report-1", "APPROVED")).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unknown report", async () => {
    const { db, service } = buildService();
    db.on("report-for-review", () => []);

    await expect(service.reviewReport(REVIEWER, "report-1", "APPROVED")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a report that is no longer PENDING", async () => {
    const { db, service } = buildService();
    db.on("report-for-review", () => [{ id: "report-1", user_id: ACTOR.id, cycle_id: "cycle-1", status: "APPROVED" }]);

    await expect(service.reviewReport(REVIEWER, "report-1", "REJECTED", "motivo")).rejects.toMatchObject({ code: "REPORT_ALREADY_REVIEWED" });
  });

  it("requires a motive to reject", async () => {
    const { service } = buildService();

    await expect(service.reviewReport(REVIEWER, "report-1", "REJECTED", "  ")).rejects.toMatchObject({
      details: { reviewNote: expect.any(String) },
    });
  });

  it("approves: fulfils the obligation and notifies the member", async () => {
    const { db, service } = buildService();

    const result = await service.reviewReport(REVIEWER, "report-1", "APPROVED", null);

    expect(result).toEqual({ id: "report-1", status: "APPROVED", userId: ACTOR.id, cycleId: "cycle-1" });
    expect(db.valuesOf("review-update")).toContain("APPROVED");
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(1);
    const notifyValues = db.execCallsFor("notify-review")[0]?.values ?? [];
    expect(notifyValues).toContain(ACTOR.id);
    expect(notifyValues).toContain("Aporte aprobado");
  });

  it("rejects: stores the motive, notifies and does NOT fulfil the obligation", async () => {
    const { db, service } = buildService();

    await service.reviewReport(REVIEWER, "report-1", "REJECTED", "Referencia no coincide");

    expect(db.valuesOf("review-update")).toContain("REJECTED");
    expect(db.valuesOf("review-update")).toContain("Referencia no coincide");
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(0);
    const notifyValues = db.execCallsFor("notify-review")[0]?.values ?? [];
    expect(notifyValues).toContain("Aporte rechazado");
    expect(String(notifyValues.join(" "))).toContain("Referencia no coincide");
  });

  it("treats losing the PENDING race as a conflict", async () => {
    const { db, service } = buildService();
    db.on("review-update", () => []);

    await expect(service.reviewReport(REVIEWER, "report-1", "APPROVED")).rejects.toMatchObject({ code: "REPORT_ALREADY_REVIEWED" });
  });
});

describe("lists", () => {
  it("lists the member's reports newest-first with their cycle", async () => {
    const { db, service } = buildService();

    const rows = await service.listMyReports(ACTOR, { limit: 500 });

    expect(rows).toEqual([MY_ROW]);
    expect(db.valuesOf("my-reports")).toEqual([ACTOR.id, 100]);
  });

  it("lists the pending review queue with the author and cycle, filtered by cycle when asked", async () => {
    const { db, service } = buildService();

    const rows = await service.listReviewQueue({ cycleId: "cycle-1", limit: 10 });

    expect(rows).toEqual([QUEUE_ROW]);
    expect(db.valuesOf("review-queue")).toEqual(["cycle-1", "cycle-1", 10]);
  });
});

describe("downlineOfferings", () => {
  const VIEWER: SessionActor = { userId: ACTOR.id, role: "MEMBER" };

  it("answers sí/no from the joined report and gates the amount on the setting (D39)", async () => {
    const shown = buildService({ settings: { "visibility.member_sees_downline_amounts": true } });
    shown.db.on("downline-offerings", () => [
      { userId: "u-2", fullName: "Ana", publicCode: "ANA001", reportId: "report-9", amount: "10.00", currency: "USD" },
      { userId: "u-3", fullName: "Beto", publicCode: "BET001", reportId: null, amount: null, currency: null },
    ]);
    expect(await shown.service.downlineOfferings(VIEWER, { cycleId: "cycle-1" })).toEqual([
      { userId: "u-2", fullName: "Ana", publicCode: "ANA001", hasOffering: true, amount: "10.00", currency: "USD" },
      { userId: "u-3", fullName: "Beto", publicCode: "BET001", hasOffering: false },
    ]);

    const hidden = buildService();
    hidden.db.on("downline-offerings", () => [
      { userId: "u-2", fullName: "Ana", publicCode: "ANA001", reportId: "report-9", amount: "10.00", currency: "USD" },
    ]);
    const [row] = await hidden.service.downlineOfferings(VIEWER, { cycleId: "cycle-1" });
    expect(row).toStrictEqual({ userId: "u-2", fullName: "Ana", publicCode: "ANA001", hasOffering: true });
    expect("amount" in row!).toBe(false);
    expect(JSON.stringify(row)).not.toContain("10.00");
  });

  it("ANDs the D40 scope cap (depth 1) and the non-REJECTED predicate into the statement", async () => {
    const { db, service } = buildService();
    db.on("downline-offerings", () => []);

    await service.downlineOfferings(VIEWER, { cycleId: "cycle-9" });

    const call = db.callsFor("downline-offerings")[0]!;
    expect(call.text).toContain("r.status <> 'REJECTED'");
    expect(call.values).toContain("cycle-9");
    const fragment = sqlFragment(call.values);
    expect(fragment?.sql).toContain("sc.depth <=");
    expect(fragment?.values).toEqual([VIEWER.userId, 1, 1]);
  });
});

describe("isUniqueViolation", () => {
  it("recognises both the pg driver code and the Prisma code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ meta: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "23P01" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
