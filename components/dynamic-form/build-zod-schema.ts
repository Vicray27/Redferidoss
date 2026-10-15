// =============================================================================
// components/dynamic-form/build-zod-schema.ts — the CLIENT-side mirror of the
// custom-field rules that lib/registration.ts enforces on the server.
//
// WHY THE RULES EXIST TWICE
// -------------------------
// The definitions live in the database (`custom_fields`), so the only place a
// rule can be AUTHORITATIVE is where the transaction re-reads them — on the
// server, after the row lock. A form cannot import that: it wants feedback
// before a round trip. So this module restates the same rules as plain
// functions the form can run on blur and on submit, in the same order, with
// the same messages. The server stays the judge; this is the clerk at the
// door. When they disagree, the server wins — and the form shows its message.
//
// WHY NOT ZOD
// -----------
// The shapes are dynamic (a list of fields, not a static interface), and the
// interesting rules are cross-field-free per-value predicates. A per-field
// `validate(field, value) → message | null` is smaller, fully typed, and
// testable without constructing a schema tree. The file keeps the spec's name
// (`buildZodSchema`) for findability.
//
// FILE FIELDS ARE NOT HERE ON PURPOSE: uploads arrive with the payment-proof
// pipeline (§5.6), and registration skips them (lib/registration.ts).
// =============================================================================

import type { RegistrationField } from "@/lib/invitations";

export interface FieldVerdict {
  ok: boolean;
  message?: string;
}

const OK: FieldVerdict = { ok: true };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()0-9][0-9\s().-]{4,24}$/;

/** Mirror of lib/registration.ts `customFieldChoices` (options jsonb). */
export function choicesOf(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const entry of options) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object" && "value" in entry) {
      out.push(String((entry as { value: unknown }).value));
    }
  }
  return out;
}

/** True when the raw form value should be treated as "not filled". */
export function isEmptyValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function withinRange(field: RegistrationField, n: number, label: string): FieldVerdict {
  if (field.minNumeric !== null && n < Number(field.minNumeric)) {
    return { ok: false, message: `${label}: el valor es demasiado bajo.` };
  }
  if (field.maxNumeric !== null && n > Number(field.maxNumeric)) {
    return { ok: false, message: `${label}: el valor es demasiado alto.` };
  }
  return OK;
}

/** Validate ONE value the way the server will. `null` raw is "not filled". */
export function validateFieldValue(field: RegistrationField, raw: unknown): FieldVerdict {
  const label = field.label;

  if (field.type === "FILE") return OK;

  if (isEmptyValue(raw)) {
    return field.isRequired
      ? { ok: false, message: `${label}: este campo es obligatorio.` }
      : OK;
  }

  switch (field.type) {
    case "BOOL": {
      if (typeof raw === "boolean" || raw === "true" || raw === "false") return OK;
      return { ok: false, message: `${label}: debe ser sí o no.` };
    }
    case "NUMBER": {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, message: `${label}: debe ser un número entero.` };
      }
      return withinRange(field, n, label);
    }
    case "DECIMAL": {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, message: `${label}: debe ser un número.` };
      return withinRange(field, n, label);
    }
    case "DATE": {
      const text = String(raw).trim();
      if (!DATE_RE.test(text)) return { ok: false, message: `${label}: usa el formato AAAA-MM-DD.` };
      const parsed = new Date(`${text}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        return { ok: false, message: `${label}: la fecha no existe.` };
      }
      return OK;
    }
    case "DATETIME": {
      if (Number.isNaN(Date.parse(String(raw).trim()))) {
        return { ok: false, message: `${label}: fecha y hora inválidas.` };
      }
      return OK;
    }
    case "SELECT": {
      const choices = choicesOf(field.options);
      const text = String(raw).trim();
      if (choices.length > 0 && !choices.includes(text)) {
        return { ok: false, message: `${label}: elige una opción válida.` };
      }
      return OK;
    }
    case "MULTISELECT": {
      const choices = choicesOf(field.options);
      const values = Array.isArray(raw) ? raw.map((v) => String(v).trim()) : [String(raw).trim()];
      if (choices.length > 0 && values.some((v) => !choices.includes(v))) {
        return { ok: false, message: `${label}: elige solo opciones válidas.` };
      }
      return OK;
    }
    case "URL": {
      try {
        const url = new URL(String(raw).trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      } catch {
        return { ok: false, message: `${label}: debe ser un enlace válido.` };
      }
      return OK;
    }
    case "EMAIL": {
      if (!EMAIL_RE.test(String(raw).trim())) {
        return { ok: false, message: `${label}: correo inválido.` };
      }
      return OK;
    }
    case "PHONE": {
      if (!PHONE_RE.test(String(raw).trim())) {
        return { ok: false, message: `${label}: teléfono inválido.` };
      }
      return OK;
    }
    default: {
      // TEXT / TEXTAREA / anything unknown — same caps and optional pattern.
      const text = String(raw).trim();
      const cap = field.type === "TEXTAREA" ? 5000 : 500;
      if (text.length > cap) return { ok: false, message: `${label}: es demasiado largo.` };
      if (field.regex) {
        try {
          if (!new RegExp(field.regex).test(text)) {
            return { ok: false, message: `${label}: no cumple el formato esperado.` };
          }
        } catch {
          // An invalid pattern is an admin error; the server ignores it too.
        }
      }
      return OK;
    }
  }
}

/**
 * Validate every field against the raw values map.
 * Returns `{ [fieldCode]: message }` — empty object means all good.
 */
export function validateCustomFields(
  fields: RegistrationField[],
  raw: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === "FILE") continue;
    const verdict = validateFieldValue(field, raw[field.code]);
    if (!verdict.ok && verdict.message) errors[field.code] = verdict.message;
  }
  return errors;
}
