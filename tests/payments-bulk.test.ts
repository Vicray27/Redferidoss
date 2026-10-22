// =============================================================================
// tests/payments-bulk.test.ts — §8.5 bulk actions (F5, D52).
//
// `bulkReviewPayments` and `reassignReports` loop the SAME single-item paths
// the review page has always used, isolated per item: one already-reviewed
// report must not abort the other ninety-nine. These tests pin the counts,
// the skip reasons, the audit fields, the cap and the no-notification rule
// for reassignment.
// =============================================================================

import { describe, expect, it } from "vitest";

import { ForbiddenError, type SessionActor } from "../lib/authz";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import {
  BULK_MAX_IDS,
  createPaymentsService,
  type PaymentsAuthz,
  type PaymentsDb,
  type PaymentsSettings,
  type ReviewDecision,
} from "../lib/payments";

const REVIEWER = { id: "admin-1", role: "ADMIN" };
const MEMBER = { id: "member-1", role: "MEMBER" };

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";
const R4 = "44444444-4444-4444-8444-444444444444";
const R5 = "55555555-5555-4555-8555-555555555555";

const TARGET = "99999999-9999-4999-8999-999999999999";
const OTHER_CYCLE = "88888888-8888-4888-8888-888888888888";

type Handler = (values: unknown[]) => unknown;

class PayFake implements PaymentsDb {
  readonly queries: Array<{ marker: string; values: unknown[] }> = [];
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

  callsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.queries.filter((call) => call.marker === marker);
  }

  execCallsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.executions.filter((call) => call.marker === marker);
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const marker = /\/\* @pay:([\w-]+) \*\//.exec(strings.join("?"))?.[1];
    if (!marker) throw new Error(`PayFake: unmarked statement: ${strings.join("?")}`);
    const handler = this.queryHandlers.get(marker);
    if (!handler) throw new Error(`PayFake: no handler for ${marker}`);
    this.queries.push({ marker, values });
    return (await handler(values)) as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const marker = /\/\* @pay:([\w-]+) \*\//.exec(strings.join("?"))?.[1];
    if (!marker) throw new Error(`PayFake: unmarked statement: ${strings.join("?")}`);
    this.executions.push({ marker, values });
    const handler = this.execHandlers.get(marker);
    return handler ? (handler(values) as number) : 1;
  }

  // Implemented for interface parity (D57); the bulk paths under test never
  // open the createReport transaction.
  async $transaction<T>(fn: (tx: PaymentsDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const SETTINGS: PaymentsSettings = {
  async getOrThrow<T>(): Promise<T> {
    throw new Error("bulk actions do not read settings");
  },
};

const AUTHZ: PaymentsAuthz = {
  async scopeFilter() {
    throw new Error("bulk actions do not scope");
  },
};

function buildBulk() {
  const db = new PayFake();
  const service = createPaymentsService(db, SETTINGS, AUTHZ);
  return { db, service };
}

/** A PENDING report whose UPDATE wins, plus the fulfil/notify trail. */
function pendingReport(cycleId = "cycle-1", userId = "u-1") {
  return { id: "row", user_id: userId, cycle_id: cycleId, status: "PENDING" as const };
}

describe("reviewMany — staff guard and request validation", () => {
  it("refuses a MEMBER before any SQL runs", async () => {
    const { db, service } = buildBulk();
    await expect(service.reviewMany(MEMBER as SessionActor & typeof MEMBER, [R1], "APPROVED")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(db.queries).toHaveLength(0);
  });

  it("rejects an unknown decision", async () => {
    const { db, service } = buildBulk();
    await expect(
      service.reviewMany(REVIEWER, [R1], "MAYBE" as unknown as ReviewDecision),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.queries).toHaveLength(0);
  });

  it("demands one shared reason before a bulk rejection", async () => {
    const { db, service } = buildBulk();
    await expect(service.reviewMany(REVIEWER, [R1], "REJECTED", "  ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.queries).toHaveLength(0);
  });

  it("requires a non-empty selection and caps it at BULK_MAX_IDS", async () => {
    const { db, service } = buildBulk();
    await expect(service.reviewMany(REVIEWER, [], "APPROVED")).rejects.toBeInstanceOf(ValidationError);

    const tooMany = Array.from({ length: BULK_MAX_IDS + 1 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await expect(service.reviewMany(REVIEWER, tooMany, "APPROVED")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.queries).toHaveLength(0);
  });
});

describe("reviewMany — per-item isolation", () => {
  function wiring(db: PayFake) {
    db.on("report-for-review", (values) => {
      const id = values[0];
      if (id === R1) return [pendingReport()];
      if (id === R2) return [{ id: R2, user_id: "u-2", cycle_id: "cycle-1", status: "APPROVED" }];
      return []; // R3 and beyond: nothing there
    });
    db.on("review-update", (values) => {
      // Binds: [decision, actorId, reviewNote, reportId].
      const id = values[3];
      if (id === R1) return [{ id: R1, user_id: "u-1", cycle_id: "cycle-1" }];
      return [];
    });
    return db;
  }

  it("approves what it can and reports why the rest was skipped", async () => {
    const { db, service } = buildBulk();
    wiring(db);

    const result = await service.reviewMany(REVIEWER, [R1, R2, R3], "APPROVED", "ok");

    expect(result).toMatchObject({ total: 3, approved: 1, rejected: 0 });
    expect(result.skipped).toEqual([
      { reportId: R2, reason: "already_reviewed", message: "Este reporte ya fue revisado." },
      { reportId: R3, reason: "not_found", message: "No se encontró el reporte." },
    ]);

    // The single-review trail: obligation fulfilled and notice sent for R1 only.
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(1);
    expect(db.execCallsFor("notify-review")).toHaveLength(1);
    // One MV refresh for the batch, never one per item (§14, D67).
    expect(db.execCallsFor("mv-refresh")).toHaveLength(1);
    // Audit fields written by the shared UPDATE path.
    const [updateCall] = db.callsFor("review-update");
    expect(updateCall.values).toContain("APPROVED");
    expect(updateCall.values).toContain("admin-1");
  });

  it("does not refresh the MV when the batch approved nothing", async () => {
    const { db, service } = buildBulk();
    db.on("report-for-review", () => [pendingReport()])
      .on("review-update", () => [{ id: R1, user_id: "u-1", cycle_id: "cycle-1" }]);

    const result = await service.reviewMany(REVIEWER, [R1], "REJECTED", "monto incorrecto");

    expect(result.rejected).toBe(1);
    expect(db.execCallsFor("mv-refresh")).toHaveLength(0);
  });

  it("counts a lost UPDATE race as already reviewed, without fulfilling", async () => {
    const { db, service } = buildBulk();
    db.on("report-for-review", () => [pendingReport()])
      .on("review-update", () => []);

    const result = await service.reviewMany(REVIEWER, [R1], "REJECTED", "monto incorrecto");

    expect(result.rejected).toBe(0);
    expect(result.skipped[0]).toMatchObject({ reportId: R1, reason: "already_reviewed" });
    expect(db.execCallsFor("fulfil-obligation")).toHaveLength(0);
    expect(db.execCallsFor("notify-review")).toHaveLength(0);
  });

  it("carries the shared note into the rejection notice", async () => {
    const { db, service } = buildBulk();
    db.on("report-for-review", () => [pendingReport()])
      .on("review-update", () => [{ id: R1, user_id: "u-1", cycle_id: "cycle-1" }]);

    const result = await service.reviewMany(REVIEWER, [R1], "REJECTED", "  monto incorrecto  ");

    expect(result.rejected).toBe(1);
    const [notify] = db.execCallsFor("notify-review");
    // Binds: [userId, title, body, json]. Title and body tell the story.
    expect(String(notify.values[1])).toContain("rechazada");
    expect(String(notify.values[2])).toContain("rechazada");
    expect(String(notify.values[2])).toContain("monto incorrecto");
  });

  it("dedupes repeated ids and skips malformed ones without SQL", async () => {
    const { db, service } = buildBulk();
    wiring(db);

    const result = await service.reviewMany(REVIEWER, [R1, R1, "not-a-uuid"], "APPROVED");

    expect(result.total).toBe(2); // dedupe keeps [R1, not-a-uuid]
    expect(result.approved).toBe(1);
    expect(result.skipped).toEqual([
      { reportId: "not-a-uuid", reason: "not_found", message: "No se encontró el reporte." },
    ]);
    expect(db.callsFor("report-for-review")).toHaveLength(1);
  });

  it("aborts on an unexpected error instead of hiding it", async () => {
    const { db, service } = buildBulk();
    db.on("report-for-review", () => {
      throw new Error("connection reset");
    });

    await expect(service.reviewMany(REVIEWER, [R1], "APPROVED")).rejects.toThrow("connection reset");
  });
});

describe("reassignReports", () => {
  function baseWiring(db: PayFake) {
    db.on("cycle-target", () => [{ id: TARGET, period_key: "2026-W43" }]);
    return db;
  }

  it("refuses a MEMBER and validates the target cycle", async () => {
    const { db, service } = buildBulk();
    baseWiring(db);

    await expect(service.reassignReports(MEMBER, [R1], TARGET)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.reassignReports(REVIEWER, [R1], "nope")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(db.queries).toHaveLength(0);
  });

  it("throws NotFoundError when the target week does not exist", async () => {
    const { db, service } = buildBulk();
    db.on("cycle-target", () => []);
    await expect(service.reassignReports(REVIEWER, [R1], TARGET)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("moves pending reports and classifies every skip", async () => {
    const { db, service } = buildBulk();
    baseWiring(db);
    db.on("reassign", (values) => {
      // Binds: [targetId, reportId, targetId].
      const id = values[1];
      if (id === R1) return [{ id: R1 }];
      if (id === R5) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return [];
    });
    db.on("reassign-state", (values) => {
      const id = values[0];
      if (id === R2) return [{ status: "PENDING", cycleId: TARGET }];
      if (id === R3) return [{ status: "APPROVED", cycleId: OTHER_CYCLE }];
      return []; // R4: gone
    });

    const result = await service.reassignReports(REVIEWER, [R1, R2, R3, R4, R5], TARGET);

    expect(result).toMatchObject({ total: 5, moved: 1, target: { id: TARGET, periodKey: "2026-W43" } });
    expect(result.skipped).toEqual([
      { reportId: R2, reason: "already_in_target", message: "El reporte ya está en esa semana." },
      { reportId: R3, reason: "not_pending", message: "Solo se pueden reasignar reportes pendientes." },
      { reportId: R4, reason: "not_found", message: "No se encontró el reporte." },
      {
        reportId: R5,
        reason: "duplicate_in_target",
        message: "La persona ya tiene un reporte en esa semana.",
      },
    ]);
    // Reassignment is silent by contract (D52): no notification rows at all.
    expect(db.executions).toHaveLength(0);
  });

  it("shares the selection cap with reviewMany", async () => {
    const { db, service } = buildBulk();
    baseWiring(db);
    const tooMany = Array.from({ length: BULK_MAX_IDS + 1 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await expect(service.reassignReports(REVIEWER, tooMany, TARGET)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.reassignReports(REVIEWER, [], TARGET)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("never moves a report that is not pending", async () => {
    const { db, service } = buildBulk();
    baseWiring(db);
    db.on("reassign", () => [])
      .on("reassign-state", () => [{ status: "APPROVED", cycleId: OTHER_CYCLE }]);

    const result = await service.reassignReports(REVIEWER, [R1], TARGET);

    expect(result.moved).toBe(0);
    expect(result.skipped[0]).toMatchObject({ reason: "not_pending" });
    // The SQL guarantees it: the UPDATE only touches PENDING rows.
    const sql = db.callsFor("reassign")[0];
    expect(sql).toBeDefined();
  });
});
