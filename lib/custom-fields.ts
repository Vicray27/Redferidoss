// =============================================================================
// lib/custom-fields.ts — the shared custom-field engine (D56).
//
// WHY THIS MODULE EXISTS
// ----------------------
// Custom fields are data, not code: the definitions live in `custom_fields`
// and several flows must judge user input against them — member registration
// (§8.3), the payment-report form (§17 / F6) and, later, the profile form.
// Each flow re-reads the definitions inside ITS OWN transaction (the client
// is never trusted with the rules), but the RULES themselves must exist once:
// a field that is "required" in registration cannot quietly stop being
// required in the payments form. This module is that single server-side
// authority; lib/registration.ts and lib/payments.ts both delegate here.
//
// The CLIENT mirror in components/dynamic-form/build-zod-schema.ts still
// restates these rules on purpose (fast feedback before a round trip); when
// the two disagree, the server wins (see that file's header).
//
// FILE FIELDS ARE NOT COLLECTIBLE HERE: uploads arrive with the payment-proof
// pipeline (§5.6, D25), so `collectCustomValues` skips FILE fields instead of
// half-validating them.
//
// UNIQUENESS IS AN APPLICATION CHECK: `custom_field_values` has no unique
// index on `value` (the GIN index supports containment queries, not equality
// across entities), so `assertCustomValuesUnique` runs a SELECT inside the
// caller's transaction. Two concurrent inserts with the same value can still
// slip through; closing that race would need a per-(field,value) index that
// the schema does not have. Documented in D56.
// =============================================================================

import { ValidationError } from "./errors";

/**
 * One row of `custom_fields` shaped for the flows that consume it.
 *
 * `isUnique` and `defaultValue` are optional at the TYPE level only because
 * older callers (and test fixtures) predate them; production queries select
 * both. Missing `isUnique` is treated as false, missing `defaultValue` as none.
 */
export interface CustomFieldRow {
  id: string;
  code: string;
  label: string;
  type: string;
  options: unknown;
  isRequired: boolean;
  isUnique?: boolean;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
  defaultValue?: unknown;
}

/** The subset of a field `validateCustomValue` needs. */
export type CustomFieldValueDef = Pick<
  CustomFieldRow,
  "code" | "label" | "type" | "options" | "regex" | "minNumeric" | "maxNumeric"
>;

export const PUBLIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one email predicate of the codebase (core email + EMAIL fields). */
export function isValidEmail(value: string): boolean {
  return PUBLIC_EMAIL_RE.test(value.trim());
}

/** Options jsonb can be `["A","B"]` or `[{value:"A"},…]`; normalize to strings. */
export function customFieldChoices(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "value" in entry) {
        return String((entry as { value: unknown }).value);
      }
      return "";
    })
    .filter((value) => value !== "");
}

export function isEmptyValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

/**
 * Validate ONE custom value against its stored definition.
 *
 * The form builds its own mirror for fast feedback, but that mirror lives in
 * the browser's trust domain. This function is the server-side authority: the
 * caller re-reads the definitions from `custom_fields` inside its transaction
 * and rejects anything that does not fit, no matter what the client sent.
 */
export function validateCustomValue(
  field: CustomFieldValueDef,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const label = field.label;

  // FILE values are not collectible at submission time (uploads arrive with
  // the payment-proof pipeline); callers skip the field entirely. Reaching
  // this branch directly is a programming error, but it must not fail silently.
  if (field.type === "FILE") {
    return { ok: false, message: `${label}: este campo se completa después del registro.` };
  }

  switch (field.type) {
    case "BOOL": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, message: `${label}: debe ser sí o no.` };
    }
    case "NUMBER": {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, message: `${label}: debe ser un número entero.` };
      }
      return withinNumericRange(field, n, label);
    }
    case "DECIMAL": {
      const text = String(raw).trim();
      const n = Number(text);
      if (!Number.isFinite(n)) {
        return { ok: false, message: `${label}: debe ser un número.` };
      }
      const ranged = withinNumericRange(field, n, label);
      // Stored as the original string: NUMERIC never round-trips through float.
      return ranged.ok ? { ok: true, value: text } : ranged;
    }
    case "DATE": {
      const text = String(raw).trim();
      // Calendar-strict: Date.parse("2026-02-31") silently rolls over, so the
      // round-trip through toISOString() is the actual check.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { ok: false, message: `${label}: usa el formato AAAA-MM-DD.` };
      }
      const parsed = new Date(`${text}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        return { ok: false, message: `${label}: la fecha no existe.` };
      }
      return { ok: true, value: text };
    }
    case "DATETIME": {
      const text = String(raw).trim();
      if (Number.isNaN(Date.parse(text))) {
        return { ok: false, message: `${label}: fecha y hora inválidas.` };
      }
      return { ok: true, value: text };
    }
    case "SELECT": {
      const text = String(raw).trim();
      const choices = customFieldChoices(field.options);
      if (choices.length > 0 && !choices.includes(text)) {
        return { ok: false, message: `${label}: elige una opción válida.` };
      }
      return { ok: true, value: text };
    }
    case "MULTISELECT": {
      const values = Array.isArray(raw) ? raw.map((v) => String(v).trim()) : [String(raw).trim()];
      const choices = customFieldChoices(field.options);
      if (choices.length > 0 && values.some((v) => !choices.includes(v))) {
        return { ok: false, message: `${label}: elige solo opciones válidas.` };
      }
      return { ok: true, value: values };
    }
    case "URL": {
      const text = String(raw).trim();
      try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      } catch {
        return { ok: false, message: `${label}: debe ser un enlace válido.` };
      }
      return { ok: true, value: text };
    }
    case "EMAIL": {
      const text = String(raw).trim();
      if (!isValidEmail(text)) return { ok: false, message: `${label}: correo inválido.` };
      return { ok: true, value: text };
    }
    case "PHONE": {
      const text = String(raw).trim();
      if (!/^[+()0-9][0-9\s().-]{4,24}$/.test(text)) {
        return { ok: false, message: `${label}: teléfono inválido.` };
      }
      return { ok: true, value: text };
    }
    default: {
      // TEXT / TEXTAREA / anything unknown: a string, optionally capped, with
      // the admin-defined pattern when there is one.
      const text = String(raw).trim();
      const cap = field.type === "TEXTAREA" ? 5000 : 500;
      if (text.length > cap) return { ok: false, message: `${label}: es demasiado largo.` };
      if (field.regex) {
        try {
          if (!new RegExp(field.regex).test(text)) {
            return { ok: false, message: `${label}: no cumple el formato esperado.` };
          }
        } catch {
          // An invalid pattern is an admin error; it must not block users.
        }
      }
      return { ok: true, value: text };
    }
  }
}

function withinNumericRange(
  field: { minNumeric: string | null; maxNumeric: string | null },
  n: number,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (field.minNumeric !== null && n < Number(field.minNumeric)) {
    return { ok: false, message: `${label}: el valor es demasiado bajo.` };
  }
  if (field.maxNumeric !== null && n > Number(field.maxNumeric)) {
    return { ok: false, message: `${label}: el valor es demasiado alto.` };
  }
  return { ok: true, value: n };
}

export interface CollectedCustomValues {
  values: Array<{ field: CustomFieldRow; value: unknown }>;
  /** Zod-style field errors, ready for fieldErrorsFrom() / §10 details. */
  errors: Record<string, string[]>;
}

/** Validate the whole submission; required fields first, skip-not-error for FILE. */
export function collectCustomValues(
  fields: CustomFieldRow[],
  raw: Record<string, unknown>,
): CollectedCustomValues {
  const values: CollectedCustomValues["values"] = [];
  const errors: CollectedCustomValues["errors"] = {};

  for (const field of fields) {
    // FILE values cannot be collected by a plain form post; the field is not
    // rendered at submission time and therefore cannot be required there either.
    if (field.type === "FILE") continue;

    const input = raw[field.code];
    if (isEmptyValue(input)) {
      if (field.isRequired) errors[field.code] = ["Este campo es obligatorio."];
      continue;
    }
    const result = validateCustomValue(field, input);
    if (result.ok) {
      values.push({ field, value: result.value });
    } else {
      errors[field.code] = [result.message];
    }
  }

  return { values, errors };
}

/** Raw client of one transaction; structurally matches RegistrationTx. */
export interface CustomFieldsTx {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export const UNIQUE_VALUE_MESSAGE = "Ya existe un registro con este valor.";

/**
 * Enforce `is_unique` on the collected values, inside the caller's transaction.
 *
 * Compares each unique field's JSON value against `custom_field_values` rows of
 * OTHER entities with the same `field_id`. Call it BEFORE inserting the new
 * values so a clash aborts without partial writes. See the header for why the
 * race is documented rather than closed.
 */
export async function assertCustomValuesUnique(
  tx: CustomFieldsTx,
  values: Array<{ field: CustomFieldRow; value: unknown }>,
  entityId: string,
): Promise<void> {
  const errors: Record<string, string[]> = {};

  for (const { field, value } of values) {
    if (!field.isUnique) continue;

    const rows = await tx.$queryRaw<Array<{ entityId: string }>>`
      /* @cf:unique-check */
      SELECT entity_id AS "entityId"
      FROM custom_field_values
      WHERE field_id = ${field.id}::uuid
        AND value = ${JSON.stringify(value)}::jsonb
        AND entity_id <> ${entityId}::uuid
      LIMIT 1
    `;

    if (rows.length > 0) errors[field.code] = [UNIQUE_VALUE_MESSAGE];
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError("Revisa los campos del formulario.", errors);
  }
}
