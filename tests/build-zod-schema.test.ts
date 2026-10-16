// =============================================================================
// tests/build-zod-schema.test.ts — the client-side mirror of the server's
// custom-field rules (components/dynamic-form/build-zod-schema.ts).
//
// These assertions document the CONTRACT the mirror promises: same checks,
// same messages as lib/custom-fields.ts `validateCustomValue`. Where the server
// and the mirror disagree, the server wins at submit time — but a disagreement
// found here is a UX bug worth fixing, not a security hole.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  choicesOf,
  isEmptyValue,
  validateCustomFields,
  validateFieldValue,
} from "@/components/dynamic-form/build-zod-schema";
import type { RegistrationField } from "@/lib/invitations";

function field(overrides: Partial<RegistrationField> & { type: string }): RegistrationField {
  return {
    code: "campo",
    label: "Campo",
    options: null,
    isRequired: false,
    regex: null,
    minNumeric: null,
    maxNumeric: null,
    sortOrder: 1,
    defaultValue: null,
    ...overrides,
  };
}

describe("choicesOf", () => {
  it("accepts a plain string array", () => {
    expect(choicesOf(["a", "b"])).toEqual(["a", "b"]);
  });

  it("accepts {value,label} objects", () => {
    expect(choicesOf([{ value: "a", label: "A" }, { value: "b", label: "B" }])).toEqual(["a", "b"]);
  });

  it("returns [] for anything else", () => {
    expect(choicesOf(null)).toEqual([]);
    expect(choicesOf("nope")).toEqual([]);
    expect(choicesOf([1, true, null])).toEqual([]);
  });
});

describe("isEmptyValue", () => {
  it("treats only undefined/null/blank/empty list as empty", () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue("   ")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue("x")).toBe(false);
  });
});

describe("validateFieldValue", () => {
  it("requires a value only for required fields", () => {
    expect(validateFieldValue(field({ type: "TEXT", isRequired: true }), "")).toMatchObject({
      ok: false,
      message: "Campo: este campo es obligatorio.",
    });
    expect(validateFieldValue(field({ type: "TEXT" }), "").ok).toBe(true);
  });

  it("skips FILE fields entirely", () => {
    expect(validateFieldValue(field({ type: "FILE", isRequired: true }), undefined).ok).toBe(true);
  });

  it("accepts both boolean spellings for BOOL and rejects the rest", () => {
    expect(validateFieldValue(field({ type: "BOOL" }), true).ok).toBe(true);
    expect(validateFieldValue(field({ type: "BOOL" }), "false").ok).toBe(true);
    expect(validateFieldValue(field({ type: "BOOL" }), "quizá").ok).toBe(false);
  });

  it("requires integers for NUMBER and finite numbers for DECIMAL", () => {
    expect(validateFieldValue(field({ type: "NUMBER" }), "3").ok).toBe(true);
    expect(validateFieldValue(field({ type: "NUMBER" }), "3.5").ok).toBe(false);
    expect(validateFieldValue(field({ type: "DECIMAL" }), "3.50").ok).toBe(true);
    expect(validateFieldValue(field({ type: "DECIMAL" }), "abc").ok).toBe(false);
  });

  it("enforces min and max for numeric fields", () => {
    const ranged = field({ type: "NUMBER", minNumeric: "5", maxNumeric: "10" });
    expect(validateFieldValue(ranged, "7").ok).toBe(true);
    expect(validateFieldValue(ranged, "4").ok).toBe(false);
    expect(validateFieldValue(ranged, "11").ok).toBe(false);
  });

  it("rejects dates that do not exist even when the format is right", () => {
    expect(validateFieldValue(field({ type: "DATE" }), "2026-02-31").ok).toBe(false);
    expect(validateFieldValue(field({ type: "DATE" }), "2026-13-01").ok).toBe(false);
    expect(validateFieldValue(field({ type: "DATE" }), "31/12/2026").ok).toBe(false);
    expect(validateFieldValue(field({ type: "DATE" }), "2026-02-28").ok).toBe(true);
  });

  it("validates SELECT against its choices, but only when there are choices", () => {
    const select = field({ type: "SELECT", options: ["Oro", "Plata"] });
    expect(validateFieldValue(select, "Oro").ok).toBe(true);
    expect(validateFieldValue(select, "Bronce").ok).toBe(false);
    // No choices configured = free text, same as the server.
    expect(validateFieldValue(field({ type: "SELECT" }), "cualquiera").ok).toBe(true);
  });

  it("validates every entry of a MULTISELECT", () => {
    const multi = field({ type: "MULTISELECT", options: ["a", "b"] });
    expect(validateFieldValue(multi, ["a", "b"]).ok).toBe(true);
    expect(validateFieldValue(multi, ["a", "c"]).ok).toBe(false);
  });

  it("validates URL, EMAIL and PHONE shapes", () => {
    expect(validateFieldValue(field({ type: "URL" }), "https://example.com").ok).toBe(true);
    expect(validateFieldValue(field({ type: "URL" }), "ftp://example.com").ok).toBe(false);
    expect(validateFieldValue(field({ type: "EMAIL" }), "a@b.co").ok).toBe(true);
    expect(validateFieldValue(field({ type: "EMAIL" }), "a@b").ok).toBe(false);
    expect(validateFieldValue(field({ type: "PHONE" }), "+595 981 000 000").ok).toBe(true);
    expect(validateFieldValue(field({ type: "PHONE" }), "abc").ok).toBe(false);
  });

  it("applies the admin regex for TEXT, ignoring an invalid pattern", () => {
    const withRegex = field({ type: "TEXT", regex: "^\\d{3}$" });
    expect(validateFieldValue(withRegex, "123").ok).toBe(true);
    expect(validateFieldValue(withRegex, "12").ok).toBe(false);

    const brokenRegex = field({ type: "TEXT", regex: "([unclosed" });
    expect(validateFieldValue(brokenRegex, "cualquier cosa").ok).toBe(true);
  });

  it("caps TEXT at 500 characters and TEXTAREA at 5000", () => {
    expect(validateFieldValue(field({ type: "TEXT" }), "x".repeat(500)).ok).toBe(true);
    expect(validateFieldValue(field({ type: "TEXT" }), "x".repeat(501)).ok).toBe(false);
    expect(validateFieldValue(field({ type: "TEXTAREA" }), "x".repeat(5000)).ok).toBe(true);
    expect(validateFieldValue(field({ type: "TEXTAREA" }), "x".repeat(5001)).ok).toBe(false);
  });
});

describe("validateCustomFields", () => {
  it("reports one message per offending field, keyed by code", () => {
    const fields = [
      field({ code: "ciudad", label: "Ciudad", type: "TEXT", isRequired: true }),
      field({ code: "edad", label: "Edad", type: "NUMBER" }),
      field({ code: "nota", label: "Nota", type: "TEXT" }),
    ];

    const errors = validateCustomFields(fields, { ciudad: "", edad: "cuarenta", nota: "ok" });

    expect(Object.keys(errors).sort()).toEqual(["ciudad", "edad"]);
    expect(errors.ciudad).toContain("obligatorio");
    expect(errors.edad).toContain("entero");
  });

  it("returns an empty object when everything is valid", () => {
    const fields = [field({ code: "ciudad", type: "TEXT", isRequired: true })];
    expect(validateCustomFields(fields, { ciudad: "Asunción" })).toEqual({});
  });
});
