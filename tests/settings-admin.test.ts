// =============================================================================
// tests/settings-admin.test.ts — §6/§10.5 validation of the settings writer.
//
// The fake db routes by `/* @settings:… */` markers. The catalog is the REAL
// one (lib/settings-catalog.ts), so these tests pin the actual types, ranges
// and options the admin screen will enforce.
// =============================================================================

import { describe, expect, it } from "vitest";

import { SETTINGS_CATALOG } from "../lib/settings-catalog";
import { createSettingsAdminService, validateSettingValue, type SettingsAdminDb } from "../lib/settings-admin";

const ADMIN = { id: "admin-1", role: "ADMIN" };
const ROOT = { id: "root-1", role: "ROOT" };
const MEMBER = { id: "user-1", role: "MEMBER" };

type Handler = (values: unknown[]) => unknown;

class SettingsFake implements SettingsAdminDb {
  readonly queries: Array<{ marker: string; values: unknown[] }> = [];
  readonly executions: Array<{ marker: string; values: unknown[]; text: string }> = [];
  /** Simulated settings rows: key -> current jsonb value. */
  readonly rows = new Map<string, unknown>([
    ["payments.week_start_day", 1],
    ["payments.grace_hours", 48],
    ["payments.expected_amount", 10],
    ["payments.currency", "USD"],
    ["payments.amount_mode", "MINIMUM"],
    ["payments.reminder_days_before_due", [1]],
    ["referral.allow_sponsor_reassign", false],
  ]);
  private readonly queryHandlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.queryHandlers.set(marker, handler);
    return this;
  }

  valuesOf(marker: string): unknown[] {
    return this.queries.filter((call) => call.marker === marker)[0]?.values ?? [];
  }

  execValuesOf(marker: string): unknown[] {
    return this.executions.filter((call) => call.marker === marker)[0]?.values ?? [];
  }

  execValuesAll(marker: string): unknown[][] {
    return this.executions.filter((call) => call.marker === marker).map((call) => call.values);
  }

  execTextOf(marker: string): string {
    return this.executions.find((call) => call.marker === marker)?.text ?? "";
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @settings:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`SettingsFake: unmarked statement: ${text}`);
    const handler = this.queryHandlers.get(marker);
    if (handler) {
      this.queries.push({ marker, values });
      return (await handler(values)) as T;
    }
    if (marker === "snapshot") {
      this.queries.push({ marker, values });
      const key = String(values[0]);
      return (this.rows.has(key) ? [{ value: this.rows.get(key) }] : []) as T;
    }
    throw new Error(`SettingsFake: no handler for ${marker}`);
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = strings.join("?");
    const marker = /\/\* @settings:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`SettingsFake: unmarked statement: ${text}`);
    this.executions.push({ marker, values, text });
    return 1;
  }
}

function build() {
  const db = new SettingsFake();
  const invalidated: string[] = [];
  const service = createSettingsAdminService(db, { invalidate: (key) => invalidated.push(key) });
  return { db, invalidated, service };
}

function sampleValueFor(entry: (typeof SETTINGS_CATALOG)[number]): unknown {
  switch (entry.type) {
    case "BOOL":
      return true;
    case "INT":
      return entry.minValue ?? 0;
    case "DECIMAL":
      return "1.00";
    case "ENUM":
      return entry.options?.[0] ?? "X";
    case "STRING":
      return "x";
    case "JSON":
      return Array.isArray(entry.value) ? [1] : typeof entry.value === "object" ? {} : 1;
  }
}

describe("validateSettingValue", () => {
  const entryOf = (key: string) => {
    const entry = SETTINGS_CATALOG.find((candidate) => candidate.key === key);
    if (!entry) throw new Error(`test: missing catalog entry ${key}`);
    return entry;
  };

  it("INT accepts numbers and numeric strings, rejects fractions and out-of-range", () => {
    const entry = entryOf("payments.week_start_day");
    expect(validateSettingValue(entry, 2)).toBe(2);
    expect(validateSettingValue(entry, "3")).toBe(3);
    expect(() => validateSettingValue(entry, 7)).toThrowError(/rango/);
    expect(() => validateSettingValue(entry, 1.5)).toThrowError(/entero/);
  });

  it("INT without a maximum accepts any value above the minimum", () => {
    const entry = entryOf("payments.grace_hours");
    expect(validateSettingValue(entry, 72)).toBe(72);
    expect(() => validateSettingValue(entry, -1)).toThrowError(/rango/);
  });

  it("DECIMAL canonicalises to a 2-decimal string and enforces the minimum", () => {
    const entry = entryOf("payments.expected_amount");
    expect(validateSettingValue(entry, "12.5")).toBe("12.50");
    expect(validateSettingValue(entry, 10)).toBe("10.00");
    expect(() => validateSettingValue(entry, "-1")).toThrowError(/rango/);
    expect(() => validateSettingValue(entry, "abc")).toThrowError(/decimal/);
  });

  it("BOOL rejects strings", () => {
    const entry = entryOf("referral.allow_sponsor_reassign");
    expect(validateSettingValue(entry, true)).toBe(true);
    expect(() => validateSettingValue(entry, "true")).toThrowError(/verdadero/);
  });

  it("STRING trims and rejects empty values", () => {
    const entry = entryOf("payments.currency");
    expect(validateSettingValue(entry, " usd ")).toBe("usd");
    expect(() => validateSettingValue(entry, "   ")).toThrowError(/vac/);
  });

  it("ENUM only accepts catalog options", () => {
    const entry = entryOf("payments.amount_mode");
    expect(validateSettingValue(entry, "FIXED")).toBe("FIXED");
    expect(() => validateSettingValue(entry, "WHATEVER")).toThrowError(/opciones/);
  });

  it("JSON keeps the list shape the catalog default defines", () => {
    const entry = entryOf("payments.reminder_days_before_due");
    expect(validateSettingValue(entry, [7, 1])).toEqual([7, 1]);
    expect(() => validateSettingValue(entry, "1")).toThrowError(/lista/);
  });
});

describe("update", () => {
  it("validates, writes, audits and invalidates each key", async () => {
    const { db, invalidated, service } = build();

    const results = await service.update(ADMIN, [{ key: "payments.week_start_day", value: 2 }]);

    expect(results).toEqual([{ key: "payments.week_start_day", before: 1, after: 2 }]);
    expect(db.execValuesOf("update")).toContain("2");
    expect(db.execTextOf("audit")).toContain("settings.update");
    const auditValues = db.execValuesOf("audit");
    expect(auditValues).toContain("payments.week_start_day");
    expect(auditValues).toContain("1");
    expect(auditValues).toContain("2");
    expect(invalidated).toEqual(["payments.week_start_day"]);
  });

  it("applies several changes in order", async () => {
    const { db, invalidated, service } = build();

    await service.update(ADMIN, [
      { key: "payments.week_start_day", value: 0 },
      { key: "payments.currency", value: "COP" },
    ]);

    expect(db.execValuesAll("update")).toHaveLength(2);
    expect(invalidated).toEqual(["payments.week_start_day", "payments.currency"]);
  });

  it("refuses a batch when any entry is invalid, without writing anything", async () => {
    const { db, service } = build();

    await expect(
      service.update(ADMIN, [
        { key: "payments.week_start_day", value: 2 },
        { key: "payments.week_start_day", value: 99 },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(db.executions).toHaveLength(0);
  });

  it("rejects unknown keys", async () => {
    const { service } = build();

    await expect(service.update(ADMIN, [{ key: "payments.invented", value: 1 }])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { "payments.invented": expect.any(String) },
    });
  });

  it("rejects a missing database row", async () => {
    const { db, service } = build();
    db.rows.delete("payments.week_start_day");

    await expect(service.update(ADMIN, [{ key: "payments.week_start_day", value: 2 }])).rejects.toMatchObject({ status: 404 });
  });

  it("rejects empty and oversized batches", async () => {
    const { service } = build();

    await expect(service.update(ADMIN, [])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const oversized = Array.from({ length: 51 }, () => ({ key: "payments.week_start_day", value: 1 }));
    await expect(service.update(ADMIN, oversized)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("lets a MEMBER write nothing", async () => {
    const { service } = build();

    await expect(service.update(MEMBER, [{ key: "payments.week_start_day", value: 2 }])).rejects.toMatchObject({ status: 403 });
  });

  it("lets ADMIN edit ADMIN keys but not ROOT-only keys", async () => {
    const { db, service } = build();

    await expect(service.update(ADMIN, [{ key: "payments.week_start_day", value: 2 }])).resolves.toHaveLength(1);

    const rootOnly = SETTINGS_CATALOG.find((entry) => entry.editableBy === "ROOT");
    if (!rootOnly) return;
    const sample = sampleValueFor(rootOnly);
    db.rows.set(rootOnly.key, sample);
    await expect(service.update(ADMIN, [{ key: rootOnly.key, value: sample }])).rejects.toMatchObject({ status: 403 });
    await expect(service.update(ROOT, [{ key: rootOnly.key, value: sample }])).resolves.toHaveLength(1);
  });
});
