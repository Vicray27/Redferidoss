// =============================================================================
// tests/custom-fields.test.ts — the shared custom-field engine (D56).
//
// These tests moved here when the rules left lib/registration.ts: the module
// under test is now lib/custom-fields.ts, and registration only delegates.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  UNIQUE_VALUE_MESSAGE,
  assertCustomValuesUnique,
  collectCustomValues,
  formatCustomValue,
  validateCustomValue,
  type CustomFieldRow,
} from "../lib/custom-fields";

const base = {
  code: "x",
  label: "Campo",
  options: null,
  regex: null,
  minNumeric: null,
  maxNumeric: null,
};

function field(overrides: Partial<CustomFieldRow> = {}): CustomFieldRow {
  return {
    id: "field-1",
    code: "campo",
    label: "Campo",
    type: "TEXT",
    options: null,
    isRequired: false,
    isUnique: false,
    regex: null,
    minNumeric: null,
    maxNumeric: null,
    defaultValue: null,
    ...overrides,
  };
}

describe("validateCustomValue", () => {
  it("accepts booleans in their JSON and form representations", () => {
    expect(validateCustomValue({ ...base, type: "BOOL" }, true)).toEqual({ ok: true, value: true });
    expect(validateCustomValue({ ...base, type: "BOOL" }, "false")).toEqual({ ok: true, value: false });
    expect(validateCustomValue({ ...base, type: "BOOL" }, "quizá").ok).toBe(false);
  });

  it("enforces SELECT options and MULTISELECT membership", () => {
    const options = ["Norte", "Sur"];
    expect(validateCustomValue({ ...base, type: "SELECT", options }, "Norte")).toEqual({
      ok: true,
      value: "Norte",
    });
    expect(validateCustomValue({ ...base, type: "SELECT", options }, "Este").ok).toBe(false);
    expect(validateCustomValue({ ...base, type: "MULTISELECT", options }, ["Norte", "Sur"])).toEqual({
      ok: true,
      value: ["Norte", "Sur"],
    });
    expect(validateCustomValue({ ...base, type: "MULTISELECT", options }, ["Norte", "Este"]).ok).toBe(false);
  });

  it("rejects impossible dates and out-of-range numbers", () => {
    expect(validateCustomValue({ ...base, type: "DATE" }, "2026-02-31").ok).toBe(false);
    expect(validateCustomValue({ ...base, type: "DATE" }, "2026-02-28")).toEqual({
      ok: true,
      value: "2026-02-28",
    });
    expect(
      validateCustomValue({ ...base, type: "NUMBER", minNumeric: "1", maxNumeric: "5" }, 9).ok,
    ).toBe(false);
    expect(
      validateCustomValue({ ...base, type: "NUMBER", minNumeric: "1", maxNumeric: "5" }, 3),
    ).toEqual({ ok: true, value: 3 });
  });
});

describe("collectCustomValues", () => {
  it("skips FILE fields instead of half-validating them", () => {
    const collected = collectCustomValues(
      [field({ id: "f1", code: "adjunto", label: "Adjunto", type: "FILE", isRequired: true })],
      {},
    );
    expect(collected.errors).toEqual({});
    expect(collected.values).toEqual([]);
  });

  it("keeps DECIMAL as its exact text and reports required gaps per code", () => {
    const collected = collectCustomValues(
      [
        field({ id: "f1", code: "meta", label: "Meta", type: "DECIMAL", minNumeric: "0" }),
        field({ id: "f2", code: "barrio", label: "Barrio", isRequired: true }),
      ],
      { meta: "10.50" },
    );
    expect(collected.errors).toEqual({ barrio: ["Este campo es obligatorio."] });
    expect(collected.values).toHaveLength(1);
    expect(collected.values[0]).toMatchObject({ value: "10.50" });
  });
});

describe("assertCustomValuesUnique", () => {
  function fakeTx(rows: unknown[] = []) {
    const calls: Array<{ marker: string; text: string; values: unknown[] }> = [];
    return {
      calls,
      $queryRaw: async <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
        const text = strings.join("?");
        const marker = /\/\* (@[\w:-]+) \*\//.exec(text)?.[1];
        if (!marker) throw new Error(`test tx: statement without marker: ${text}`);
        calls.push({ marker, text, values });
        return rows as T;
      },
    };
  }

  it("does not query at all when no collected field is unique", async () => {
    const tx = fakeTx();
    await expect(
      assertCustomValuesUnique(tx, [{ field: field(), value: "Centro" }], "entity-1"),
    ).resolves.toBeUndefined();
    expect(tx.calls).toHaveLength(0);
  });

  it("runs the clashing lookup with the field, JSON value and excluded entity", async () => {
    const tx = fakeTx([{ entityId: "other-entity" }]);
    await expect(
      assertCustomValuesUnique(
        tx,
        [{ field: field({ id: "f9", code: "documento", isUnique: true }), value: "1234567" }],
        "entity-1",
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      status: 400,
      details: { documento: [UNIQUE_VALUE_MESSAGE] },
    });

    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].marker).toBe("@cf:unique-check");
    expect(tx.calls[0].values).toEqual(["f9", JSON.stringify("1234567"), "entity-1"]);
  });

  it("passes when the value is unique across entities", async () => {
    const tx = fakeTx([]);
    await expect(
      assertCustomValuesUnique(
        tx,
        [{ field: field({ id: "f9", isUnique: true }), value: 42 }],
        "entity-1",
      ),
    ).resolves.toBeUndefined();
    expect(tx.calls).toHaveLength(1);
  });

  it("ignores values owned by a REJECTED payment report (exclusion pinned in SQL)", async () => {
    const tx = fakeTx([]);
    await expect(
      assertCustomValuesUnique(
        tx,
        [{ field: field({ id: "f9", code: "documento", isUnique: true }), value: "A1" }],
        "entity-1",
      ),
    ).resolves.toBeUndefined();

    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].text).toContain("NOT EXISTS");
    expect(tx.calls[0].text).toContain("pr.status = 'REJECTED'");
  });
});

describe("formatCustomValue — stored jsonb back to display text", () => {
  it("renders booleans, lists and scalars the way a person typed them", () => {
    expect(formatCustomValue(true)).toBe("Sí");
    expect(formatCustomValue(false)).toBe("No");
    expect(formatCustomValue(["Norte", "Sur"])).toBe("Norte, Sur");
    expect(formatCustomValue("Centro")).toBe("Centro");
    expect(formatCustomValue(10.5)).toBe("10.5");
  });

  it("renders missing values as an empty string", () => {
    expect(formatCustomValue(null)).toBe("");
    expect(formatCustomValue(undefined)).toBe("");
  });
});
