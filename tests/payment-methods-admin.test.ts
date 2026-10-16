// =============================================================================
// tests/payment-methods-admin.test.ts — §5.6/§8.5 payment methods CRUD.
//
// The fake db routes by `/* @pmadmin:… */` markers and keeps a tiny in-memory
// catalog, so these tests pin the real contract: staff-only, code immutable,
// no delete, reorder by dense renumbering, one audit row per accepted write.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  createPaymentMethodsAdminService,
  METHOD_CODE_RE,
  validateNewPaymentMethod,
  validatePaymentMethodUpdate,
  type PaymentMethodsAdminDb,
  type PaymentMethodRow,
} from "../lib/payment-methods-admin";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", role: "ADMIN" };
const ROOT = { id: "22222222-2222-4222-8222-222222222222", role: "ROOT" };
const MEMBER = { id: "33333333-3333-4333-8333-333333333333", role: "MEMBER" };

const PM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function row(overrides: Partial<PaymentMethodRow> = {}): PaymentMethodRow {
  return {
    id: PM_A,
    code: "TRANSFER",
    label: "Transferencia",
    instructions: null,
    requiresReference: true,
    requiresProof: false,
    isActive: true,
    sortOrder: 1,
    ...overrides,
  };
}

type Handler = (values: unknown[]) => unknown;

class MethodsFake implements PaymentMethodsAdminDb {
  readonly queries: Array<{ marker: string; values: unknown[]; text: string }> = [];
  readonly executions: Array<{ marker: string; values: unknown[]; text: string }> = [];
  /** In-memory catalog, already ordered the way the SQL would return it. */
  rows: PaymentMethodRow[] = [];
  private readonly queryHandlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.queryHandlers.set(marker, handler);
    return this;
  }

  valuesOf(marker: string): unknown[] {
    return this.queries.find((call) => call.marker === marker)?.values ?? [];
  }

  execValuesOf(marker: string): unknown[] {
    return this.executions.find((call) => call.marker === marker)?.values ?? [];
  }

  execValuesAll(marker: string): unknown[][] {
    return this.executions.filter((call) => call.marker === marker).map((call) => call.values);
  }

  execTextOf(marker: string): string {
    return this.executions.find((call) => call.marker === marker)?.text ?? "";
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @pmadmin:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`MethodsFake: unmarked statement: ${text}`);
    this.queries.push({ marker, values: scalars(values), text });
    const handler = this.queryHandlers.get(marker);
    if (!handler) throw new Error(`MethodsFake: no handler for ${marker}`);
    return (await handler(scalars(values))) as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = strings.join("?");
    const marker = /\/\* @pmadmin:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`MethodsFake: unmarked statement: ${text}`);
    this.executions.push({ marker, values: scalars(values), text });
    if (marker === "set-order") {
      const [nextOrder, id] = scalars(values) as [number, string];
      const found = this.rows.find((candidate) => candidate.id === id);
      if (found) found.sortOrder = nextOrder;
    }
    return 1;
  }
}

/**
 * The real Prisma client inlines `${Prisma.sql\`…\`}` interpolations; the fake
 * only needs the scalar binds, which is what the assertions read.
 */
function scalars(values: unknown[]): unknown[] {
  return values.filter((value) => !(value !== null && typeof value === "object" && "sql" in value));
}

function build() {
  const db = new MethodsFake();
  db.on("list", () => db.rows);
  const service = createPaymentMethodsAdminService(db);
  return { db, service };
}

describe("validateNewPaymentMethod", () => {
  it("uppercases and trims the code, and applies the documented defaults", () => {
    const canonical = validateNewPaymentMethod({ code: "  nequi ", label: "  Nequi  " });
    expect(canonical).toEqual({
      code: "NEQUI",
      label: "Nequi",
      instructions: null,
      requiresReference: true,
      requiresProof: false,
      isActive: true,
      sortOrder: 0,
    });
  });

  it("matches the existing enum vocabulary shape and rejects malformed codes", () => {
    expect(METHOD_CODE_RE.test("TRANSFER")).toBe(true);
    expect(METHOD_CODE_RE.test("MOBILE_PAY")).toBe(true);
    for (const bad of ["9TRANSFER", "CON ESPACIO", "ñ", "A", "guión", ""]) {
      expect(() => validateNewPaymentMethod({ code: bad, label: "X" })).toThrowError(/letra inicial/);
    }
  });

  it("rejects a blank label and an out-of-range sortOrder", () => {
    expect(() => validateNewPaymentMethod({ code: "NEQUI", label: "   " })).toThrowError(/Escribe/);
    expect(() => validateNewPaymentMethod({ code: "NEQUI", label: "Nequi", sortOrder: 1.5 })).toThrowError(
      /entero/,
    );
  });
});

describe("validatePaymentMethodUpdate", () => {
  it("keeps only the provided keys and never reads `code`", () => {
    expect(validatePaymentMethodUpdate({ label: " Otro ", requiresProof: true })).toEqual({
      label: "Otro",
      requiresProof: true,
    });
    expect(validatePaymentMethodUpdate({ instructions: "   " })).toEqual({ instructions: null });
    expect(validatePaymentMethodUpdate({})).toEqual({});
  });
});

describe("createPaymentMethodsAdminService", () => {
  it("rejects MEMBER on every method without running SQL", async () => {
    const { db, service } = build();
    // ForbiddenError hides WHY access was refused (anti-oracle, lib/authz.ts).
    await expect(service.list(MEMBER)).rejects.toThrowError(/No tienes permiso/);
    await expect(service.create(MEMBER, { code: "NEQUI", label: "Nequi" })).rejects.toThrowError(
      /No tienes permiso/,
    );
    await expect(service.update(MEMBER, PM_A, { label: "X" })).rejects.toThrowError(/No tienes permiso/);
    await expect(service.move(MEMBER, PM_A, "up")).rejects.toThrowError(/No tienes permiso/);
    expect(db.queries).toHaveLength(0);
    expect(db.executions).toHaveLength(0);
  });

  it("lists every method, inactive included, through the ordered query", async () => {
    const { db, service } = build();
    db.rows = [row(), row({ id: PM_B, code: "CASH", label: "Efectivo", sortOrder: 2, isActive: false })];
    // ROOT has the same reach as ADMIN on this surface.
    await expect(service.list(ROOT)).resolves.toHaveLength(2);
    expect(db.queries[0].text).toMatch(/ORDER BY sort_order, code/);
  });

  it("creates with the canonical payload and writes the audit row", async () => {
    const { db, service } = build();
    db.on("exists", () => []);
    db.on("insert", (values) => {
      const [code, label, instructions, requiresReference, requiresProof, isActive, sortOrder] =
        values as [string, string, string | null, boolean, boolean, boolean, number];
      return [row({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", code, label, instructions, requiresReference, requiresProof, isActive, sortOrder })];
    });

    const created = await service.create(ADMIN, { code: "nequi", label: "Nequi", requiresProof: true });
    expect(created).toMatchObject({ code: "NEQUI", label: "Nequi", requiresProof: true });
    expect(db.valuesOf("insert")).toEqual(["NEQUI", "Nequi", null, true, true, true, 0]);

    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("payment_method.create");
    expect(audit[2]).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(audit[3]).toBeNull();
    expect(JSON.parse(String(audit[4]))).toMatchObject({ code: "NEQUI" });
  });

  it("rejects a duplicate code before the insert and on a unique violation race", async () => {
    const { db, service } = build();
    db.on("exists", () => [{ id: PM_A }]);
    await expect(service.create(ADMIN, { code: "TRANSFER", label: "Transferencia" })).rejects.toThrowError(
      /Ya existe/,
    );
    expect(db.queries.some((call) => call.marker === "insert")).toBe(false);

    db.on("exists", () => []);
    db.on("insert", () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });
    await expect(service.create(ADMIN, { code: "TRANSFER", label: "Transferencia" })).rejects.toThrowError(/Ya existe/);
  });

  it("updates only the provided fields, keeps code immutable, and audits before/after", async () => {
    const { db, service } = build();
    db.rows = [row({ id: PM_A, label: "Transferencia", requiresReference: true, sortOrder: 3 })];
    db.on("snapshot", () => db.rows);

    const updated = await service.update(ADMIN, PM_A, { label: "Transferencia bancaria", isActive: false });
    expect(updated).toMatchObject({
      code: "TRANSFER",
      label: "Transferencia bancaria",
      requiresReference: true,
      isActive: false,
      sortOrder: 3,
    });
    expect(db.execValuesOf("update")).toEqual(["Transferencia bancaria", null, true, false, false, 3, PM_A]);
    expect(db.execTextOf("update")).not.toMatch(/code\s*=/);

    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("payment_method.update");
    expect(JSON.parse(String(audit[3]))).toMatchObject({ label: "Transferencia", isActive: true });
    expect(JSON.parse(String(audit[4]))).toMatchObject({ label: "Transferencia bancaria", isActive: false });
  });

  it("rejects an unknown or malformed id on update", async () => {
    const { db, service } = build();
    await expect(service.update(ADMIN, "not-a-uuid", { label: "X" })).rejects.toThrowError(/No se encontró/);
    db.on("snapshot", () => []);
    await expect(service.update(ADMIN, PM_A, { label: "X" })).rejects.toThrowError(/No se encontró/);
    expect(db.executions).toHaveLength(0);
  });

  it("moves a row by densely renumbering the ordered list", async () => {
    const { db, service } = build();
    db.rows = [
      row({ id: PM_A, code: "TRANSFER", sortOrder: 1 }),
      row({ id: PM_B, code: "CASH", sortOrder: 2 }),
      row({ id: PM_C, code: "ZELLE", sortOrder: 2 }),
    ];
    // Ties resolved by code: CASH sits before ZELLE. Moving ZELLE up must give
    // the visible order A, ZELLE, CASH — only CASH's order actually moves.
    const result = await service.move(ADMIN, PM_C, "up");
    expect(result).toEqual({ id: PM_C, direction: "up", moved: true });
    expect(db.execValuesAll("set-order")).toEqual([[3, PM_B]]);
    expect(db.rows.find((r) => r.id === PM_A)?.sortOrder).toBe(1);
    expect(db.rows.find((r) => r.id === PM_C)?.sortOrder).toBe(2);
    expect(db.rows.find((r) => r.id === PM_B)?.sortOrder).toBe(3);
  });

  it("reports moved: false at the boundaries and rejects unknown ids", async () => {
    const { db, service } = build();
    db.rows = [row({ id: PM_A, sortOrder: 1 }), row({ id: PM_B, sortOrder: 2 })];

    await expect(service.move(ADMIN, PM_A, "up")).resolves.toEqual({ id: PM_A, direction: "up", moved: false });
    await expect(service.move(ADMIN, PM_B, "down")).resolves.toEqual({ id: PM_B, direction: "down", moved: false });
    expect(db.executions.filter((call) => call.marker === "set-order")).toHaveLength(0);

    await expect(service.move(ADMIN, "not-a-uuid", "up")).rejects.toThrowError(/No se encontró/);
    await expect(service.move(ADMIN, PM_A, "sideways" as "up")).rejects.toThrowError(/dirección/);
  });

  it("audits a successful move with the direction", async () => {
    const { db, service } = build();
    db.rows = [row({ id: PM_A, sortOrder: 1 }), row({ id: PM_B, code: "CASH", sortOrder: 2 })];
    await service.move(ADMIN, PM_B, "up");
    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("payment_method.reorder");
    expect(audit[2]).toBe(PM_B);
    expect(JSON.parse(String(audit[3]))).toMatchObject({ sortOrder: 2 });
    expect(JSON.parse(String(audit[4]))).toMatchObject({ sortOrder: 1, direction: "up" });
  });
});
