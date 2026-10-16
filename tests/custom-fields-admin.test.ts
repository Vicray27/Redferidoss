// =============================================================================
// tests/custom-fields-admin.test.ts — §8.5 custom fields CRUD (D56).
//
// The fake db routes by `/* @cfadmin:… */` markers and keeps a tiny in-memory
// table, so these tests pin the real contract: staff-only, entity/code/type
// frozen after create, no delete (deactivate), default stored in canonical
// form, reorder by dense renumbering inside the entity group, one audit row
// per accepted write.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  FIELD_CODE_RE,
  createCustomFieldsAdminService,
  validateCustomFieldUpdate,
  validateNewCustomField,
  type CustomFieldAdminRow,
  type CustomFieldsAdminDb,
} from "../lib/custom-fields-admin";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", role: "ADMIN" };
const ROOT = { id: "22222222-2222-4222-8222-222222222222", role: "ROOT" };
const MEMBER = { id: "33333333-3333-4333-8333-333333333333", role: "MEMBER" };

const CF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CF_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function row(overrides: Partial<CustomFieldAdminRow> = {}): CustomFieldAdminRow {
  return {
    id: CF_A,
    entity: "USER",
    code: "BARRIO",
    label: "Barrio",
    type: "TEXT",
    options: null,
    isRequired: false,
    isUnique: false,
    showInRegistration: true,
    showInProfile: false,
    showInDashboard: false,
    visibleTo: null,
    regex: null,
    minNumeric: null,
    maxNumeric: null,
    defaultValue: null,
    sortOrder: 1,
    isActive: true,
    ...overrides,
  };
}

type Handler = (values: unknown[]) => unknown;

class FieldsFake implements CustomFieldsAdminDb {
  readonly queries: Array<{ marker: string; values: unknown[]; text: string }> = [];
  readonly executions: Array<{ marker: string; values: unknown[]; text: string }> = [];
  /** In-memory table, already ordered the way the SQL would return it. */
  rows: CustomFieldAdminRow[] = [];
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
    const marker = /\/\* @cfadmin:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`FieldsFake: unmarked statement: ${text}`);
    this.queries.push({ marker, values: scalars(values), text });
    const handler = this.queryHandlers.get(marker);
    if (!handler) throw new Error(`FieldsFake: no handler for ${marker}`);
    return (await handler(scalars(values))) as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = strings.join("?");
    const marker = /\/\* @cfadmin:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`FieldsFake: unmarked statement: ${text}`);
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
  const db = new FieldsFake();
  db.on("list", () => db.rows);
  const service = createCustomFieldsAdminService(db);
  return { db, service };
}

describe("validateNewCustomField", () => {
  it("uppercases the code and applies the documented defaults", () => {
    const canonical = validateNewCustomField({
      entity: "USER",
      code: "  barrio ",
      label: "  Barrio  ",
      type: "TEXT",
    });
    expect(canonical).toEqual({
      entity: "USER",
      code: "BARRIO",
      label: "Barrio",
      type: "TEXT",
      options: null,
      isRequired: false,
      isUnique: false,
      showInRegistration: false,
      showInProfile: false,
      showInDashboard: false,
      visibleTo: null,
      regex: null,
      minNumeric: null,
      maxNumeric: null,
      defaultValue: null,
      sortOrder: 0,
      isActive: true,
    });
  });

  it("requires a non-empty, deduplicated choice list for SELECT types", () => {
    expect(() =>
      validateNewCustomField({ entity: "USER", code: "ZONA", label: "Zona", type: "SELECT" }),
    ).toThrowError(/al menos una opción/);
    const canonical = validateNewCustomField({
      entity: "USER",
      code: "ZONA",
      label: "Zona",
      type: "MULTISELECT",
      options: [" Norte ", "Sur", "Norte", ""],
    });
    expect(canonical.options).toEqual(["Norte", "Sur"]);
  });

  it("ignores options, regex and ranges on types that do not use them", () => {
    const canonical = validateNewCustomField({
      entity: "PAYMENT_REPORT",
      code: "MONTO",
      label: "Monto",
      type: "NUMBER",
      options: ["A"],
      regex: "[0-9]+",
      minNumeric: "1",
      maxNumeric: "5",
    });
    expect(canonical.options).toBeNull();
    expect(canonical.regex).toBeNull();
    expect(canonical.minNumeric).toBe("1");
    expect(canonical.maxNumeric).toBe("5");
  });

  it("rejects malformed codes, labels, regex and ranges", () => {
    expect(FIELD_CODE_RE.test("BARRIO")).toBe(true);
    for (const bad of ["9BARRIO", "CON ESPACIO", "ñ", "A", ""]) {
      expect(() =>
        validateNewCustomField({ entity: "USER", code: bad, label: "X", type: "TEXT" }),
      ).toThrowError(/letra inicial/);
    }
    expect(() =>
      validateNewCustomField({ entity: "USER", code: "X1", label: "  ", type: "TEXT" }),
    ).toThrowError(/Escribe/);
    expect(() =>
      validateNewCustomField({ entity: "USER", code: "X1", label: "X", type: "TEXT", regex: "([" }),
    ).toThrowError(/expresión regular/);
    expect(() =>
      validateNewCustomField({
        entity: "USER",
        code: "X1",
        label: "X",
        type: "NUMBER",
        minNumeric: "9",
        maxNumeric: "1",
      }),
    ).toThrowError(/mínimo/);
  });

  it("stores the default in canonical form and forces isUnique off for FILE", () => {
    const bool = validateNewCustomField({
      entity: "USER",
      code: "ACTIVO",
      label: "Activo",
      type: "BOOL",
      defaultValue: "true",
    });
    expect(bool.defaultValue).toBe(true);

    expect(() =>
      validateNewCustomField({
        entity: "USER",
        code: "ACTIVO",
        label: "Activo",
        type: "BOOL",
        defaultValue: "quizá",
      }),
    ).toThrowError(/sí o no/);

    const file = validateNewCustomField({
      entity: "PAYMENT_REPORT",
      code: "ADJUNTO",
      label: "Adjunto",
      type: "FILE",
      isUnique: true,
      defaultValue: "x",
    });
    expect(file.isUnique).toBe(false);
    expect(file.defaultValue).toBeNull();
  });

  it("validates entity, type and visibility against their catalogs", () => {
    expect(() =>
      validateNewCustomField({ entity: "OTRO" as "USER", code: "X1", label: "X", type: "TEXT" }),
    ).toThrowError(/entidad/);
    expect(() =>
      validateNewCustomField({ entity: "USER", code: "X1", label: "X", type: "NOPE" as "TEXT" }),
    ).toThrowError(/tipo de campo/);
    expect(() =>
      validateNewCustomField({
        entity: "USER",
        code: "X1",
        label: "X",
        type: "TEXT",
        visibleTo: "OWNER" as "MEMBER",
      }),
    ).toThrowError(/visibilidad/);
  });
});

describe("validateCustomFieldUpdate", () => {
  it("keeps only the provided keys and re-validates against the frozen type", () => {
    const current = row({ type: "TEXT", label: "Barrio", options: null });
    expect(validateCustomFieldUpdate({ label: " Otro " }, current)).toEqual({ label: "Otro" });
    expect(validateCustomFieldUpdate({}, current)).toEqual({});
    // options sent for a TEXT field are ignored, not stored.
    expect(validateCustomFieldUpdate({ options: ["A"] }, current)).toEqual({ options: null });
  });

  it("judges the default against the post-update shape", () => {
    const current = row({ type: "TEXT", label: "Barrio" });
    expect(validateCustomFieldUpdate({ defaultValue: "Centro" }, current)).toEqual({
      defaultValue: "Centro",
    });
    // null clears it; an invalid value is rejected.
    expect(validateCustomFieldUpdate({ defaultValue: null }, current)).toEqual({
      defaultValue: null,
    });
    const number = row({ type: "NUMBER", minNumeric: "1", maxNumeric: "5" });
    expect(() => validateCustomFieldUpdate({ defaultValue: 9 }, number)).toThrowError(/demasiado alto/);
  });
});

describe("createCustomFieldsAdminService", () => {
  it("rejects MEMBER on every method without running SQL", async () => {
    const { db, service } = build();
    await expect(service.list(MEMBER)).rejects.toThrowError(/No tienes permiso/);
    await expect(
      service.create(MEMBER, { entity: "USER", code: "X1", label: "X", type: "TEXT" }),
    ).rejects.toThrowError(/No tienes permiso/);
    await expect(service.update(MEMBER, CF_A, { label: "X" })).rejects.toThrowError(/No tienes permiso/);
    await expect(service.move(MEMBER, CF_A, "up")).rejects.toThrowError(/No tienes permiso/);
    expect(db.queries).toHaveLength(0);
    expect(db.executions).toHaveLength(0);
  });

  it("lists every field, inactive included, through the ordered query", async () => {
    const { db, service } = build();
    db.rows = [row(), row({ id: CF_B, entity: "PAYMENT_REPORT", code: "MONTO", isActive: false })];
    await expect(service.list(ROOT)).resolves.toHaveLength(2);
    expect(db.queries[0].text).toMatch(/ORDER BY entity, sort_order, code/);
  });

  it("creates with the canonical payload, serializing options and default as jsonb", async () => {
    const { db, service } = build();
    db.on("exists", () => []);
    db.on("insert", (values) => {
      const [entity, code, label, type, , isRequired, , , , , , , , , , sortOrder] = values as [
        CustomFieldAdminRow["entity"],
        string,
        string,
        CustomFieldAdminRow["type"],
        string | null,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        boolean,
      ];
      return [row({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", entity, code, label, type, isRequired, sortOrder })];
    });

    const created = await service.create(ADMIN, {
      entity: "PAYMENT_REPORT",
      code: "monto",
      label: "Monto",
      type: "NUMBER",
      isRequired: true,
      minNumeric: "1",
      maxNumeric: "100",
      defaultValue: 5,
      showInDashboard: true,
      sortOrder: 4,
    });
    expect(created).toMatchObject({ code: "MONTO", type: "NUMBER", entity: "PAYMENT_REPORT" });

    const values = db.valuesOf("insert");
    expect(values[0]).toBe("PAYMENT_REPORT");
    expect(values[1]).toBe("MONTO");
    expect(values[4]).toBeNull(); // options not applicable
    expect(values[14]).toBe(JSON.stringify(5)); // default_value jsonb
    expect(values[15]).toBe(4);

    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("custom_field.create");
    expect(audit[2]).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(audit[3]).toBeNull();
    expect(JSON.parse(String(audit[4]))).toMatchObject({ code: "MONTO" });
  });

  it("rejects a duplicate (entity, code) before the insert and on a unique violation race", async () => {
    const { db, service } = build();
    db.on("exists", () => [{ id: CF_A }]);
    await expect(
      service.create(ADMIN, { entity: "USER", code: "BARRIO", label: "Barrio", type: "TEXT" }),
    ).rejects.toThrowError(/Ya existe/);
    expect(db.queries.some((call) => call.marker === "insert")).toBe(false);

    db.on("exists", () => []);
    db.on("insert", () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });
    await expect(
      service.create(ADMIN, { entity: "USER", code: "BARRIO", label: "Barrio", type: "TEXT" }),
    ).rejects.toThrowError(/Ya existe/);
  });

  it("updates only the provided fields, keeps entity/code/type frozen, and audits before/after", async () => {
    const { db, service } = build();
    db.rows = [row({ id: CF_A, label: "Barrio", isRequired: true, sortOrder: 3 })];
    db.on("snapshot", () => db.rows);

    const updated = await service.update(ADMIN, CF_A, { label: " Barrio nuevo ", isActive: false });
    expect(updated).toMatchObject({
      entity: "USER",
      code: "BARRIO",
      type: "TEXT",
      label: "Barrio nuevo",
      isRequired: true,
      isActive: false,
      sortOrder: 3,
    });

    const values = db.execValuesOf("update");
    expect(values[0]).toBe("Barrio nuevo");
    expect(values[2]).toBe(true); // is_required kept from the snapshot
    expect(values[12]).toBe(3); // sort_order kept
    expect(values[13]).toBe(false);
    expect(values[14]).toBe(CF_A);
    expect(db.execTextOf("update")).not.toMatch(/\bcode\s*=/);
    expect(db.execTextOf("update")).not.toMatch(/\btype\s*=/);

    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("custom_field.update");
    expect(JSON.parse(String(audit[3]))).toMatchObject({ label: "Barrio", isActive: true });
    expect(JSON.parse(String(audit[4]))).toMatchObject({ label: "Barrio nuevo", isActive: false });
  });

  it("rejects an unknown or malformed id on update", async () => {
    const { db, service } = build();
    await expect(service.update(ADMIN, "not-a-uuid", { label: "X" })).rejects.toThrowError(/No se encontró/);
    db.on("snapshot", () => []);
    await expect(service.update(ADMIN, CF_A, { label: "X" })).rejects.toThrowError(/No se encontró/);
    expect(db.executions).toHaveLength(0);
  });

  it("moves a row by densely renumbering only its entity group", async () => {
    const { db, service } = build();
    db.rows = [
      row({ id: CF_A, entity: "USER", code: "BARRIO", sortOrder: 1 }),
      row({ id: CF_B, entity: "USER", code: "CIUDAD", sortOrder: 2 }),
      row({ id: CF_C, entity: "PAYMENT_REPORT", code: "MONTO", sortOrder: 9 }),
    ];
    // Ties resolved by code; the PAYMENT_REPORT row keeps its 9 — it is not
    // part of the USER group being renumbered.
    const result = await service.move(ADMIN, CF_B, "up");
    expect(result).toEqual({ id: CF_B, direction: "up", moved: true });
    expect(db.execValuesAll("set-order")).toEqual([[1, CF_B], [2, CF_A]]);
    expect(db.rows.find((r) => r.id === CF_A)?.sortOrder).toBe(2);
    expect(db.rows.find((r) => r.id === CF_B)?.sortOrder).toBe(1);
    expect(db.rows.find((r) => r.id === CF_C)?.sortOrder).toBe(9);
  });

  it("reports moved: false at the boundaries and rejects unknown ids", async () => {
    const { db, service } = build();
    db.rows = [row({ id: CF_A, sortOrder: 1 }), row({ id: CF_B, code: "CIUDAD", sortOrder: 2 })];

    await expect(service.move(ADMIN, CF_A, "up")).resolves.toEqual({ id: CF_A, direction: "up", moved: false });
    await expect(service.move(ADMIN, CF_B, "down")).resolves.toEqual({ id: CF_B, direction: "down", moved: false });
    expect(db.executions.filter((call) => call.marker === "set-order")).toHaveLength(0);

    await expect(service.move(ADMIN, "not-a-uuid", "up")).rejects.toThrowError(/No se encontró/);
    await expect(service.move(ADMIN, CF_A, "sideways" as "up")).rejects.toThrowError(/dirección/);
  });

  it("audits a successful move with the direction", async () => {
    const { db, service } = build();
    db.rows = [row({ id: CF_A, sortOrder: 1 }), row({ id: CF_B, code: "CIUDAD", sortOrder: 2 })];
    await service.move(ADMIN, CF_B, "up");
    const audit = db.execValuesOf("audit");
    expect(audit[1]).toBe("custom_field.reorder");
    expect(audit[2]).toBe(CF_B);
    expect(JSON.parse(String(audit[3]))).toMatchObject({ sortOrder: 2 });
    expect(JSON.parse(String(audit[4]))).toMatchObject({ sortOrder: 1, direction: "up" });
  });
});
