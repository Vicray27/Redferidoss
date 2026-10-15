// =============================================================================
// lib/settings-admin.ts — §6/§10.5: the only writer of the `settings` table.
//
// The catalog (lib/settings-catalog.ts) defines which keys exist and their
// shape; this service is what turns an admin submission into a validated,
// audited UPDATE. It deliberately refuses anything the catalog does not
// define — a typo in a key is a 400, not a new row — and it validates the
// value against the catalog's type/min/max/options BEFORE touching the
// database, so a batch either applies fully or fails on the first bad entry.
//
// Permission model (§5.7 `editable_by`): ROOT > ADMIN, and MEMBER can never
// write. Every accepted change writes one audit_log row (§5.9) with the
// before/after values, and calls the injected `invalidate` so the local
// settings cache drops the key; the migration 0002 trigger NOTIFYs every
// other instance, which is what makes acceptance A1 hold without a restart.
// =============================================================================

import { ForbiddenError } from "./authz";
import { NotFoundError, ValidationError } from "./errors";
import { compareAmounts, formatAmount, parseAmount } from "./money";
import { SETTINGS_CATALOG_BY_KEY, type CatalogEntry } from "./settings-catalog";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface SettingsAdminDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface SettingsActor {
  id: string;
  role: string;
}

export interface SettingsChange {
  key: string;
  value: unknown;
}

export interface SettingsChangeResult {
  key: string;
  before: unknown;
  after: unknown;
}

export interface SettingsAdminOptions {
  /** Local cache invalidation (usually `settings.invalidate`). */
  invalidate?: (key: string) => void;
}

export interface SettingsAdminService {
  /**
   * Validates every change, then applies them in order. Each applied change
   * writes an audit_log row and invalidates the local cache entry.
   */
  update(actor: SettingsActor, changes: readonly SettingsChange[]): Promise<SettingsChangeResult[]>;
}

const MAX_CHANGES_PER_UPDATE = 50;

const ROLE_RANK: Record<string, number> = { MEMBER: 0, ADMIN: 1, ROOT: 2 };

function describeRange(entry: CatalogEntry): string {
  if (entry.minValue !== undefined && entry.maxValue !== undefined) {
    return `Debe estar entre ${entry.minValue} y ${entry.maxValue}.`;
  }
  if (entry.minValue !== undefined) return `No puede ser menor que ${entry.minValue}.`;
  if (entry.maxValue !== undefined) return `No puede ser mayor que ${entry.maxValue}.`;
  return "El valor está fuera del rango permitido.";
}

/**
 * Validates `value` against the catalog entry and returns its canonical form:
 * numbers for INT/DECIMAL-scaled EXACTLY as DECIMAL strings ("10.05") for
 * DECIMAL, booleans for BOOL, trimmed strings for STRING/ENUM, and the value
 * as-is for JSON. Exported because the /admin form (WU7) reuses it client-side
 * for inline feedback.
 */
export function validateSettingValue(entry: CatalogEntry, value: unknown): unknown {
  const field = entry.key;
  switch (entry.type) {
    case "INT": {
      const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isInteger(numeric) || !Number.isFinite(numeric)) {
        throw new ValidationError(`El valor de "${entry.label}" debe ser un número entero.`, { [field]: "Escribe un número entero." });
      }
      if (entry.minValue !== undefined && numeric < entry.minValue) {
        throw new ValidationError(`El valor de "${entry.label}" está fuera del rango permitido.`, { [field]: describeRange(entry) });
      }
      if (entry.maxValue !== undefined && numeric > entry.maxValue) {
        throw new ValidationError(`El valor de "${entry.label}" está fuera del rango permitido.`, { [field]: describeRange(entry) });
      }
      return numeric;
    }

    case "DECIMAL": {
      let cents: bigint;
      try {
        cents = parseAmount(value);
      } catch {
        throw new ValidationError(`El valor de "${entry.label}" debe ser un número decimal con hasta 2 decimales.`, { [field]: "Usa un número con hasta 2 decimales." });
      }
      if (entry.minValue !== undefined && compareAmounts(cents, parseAmount(entry.minValue)) < 0) {
        throw new ValidationError(`El valor de "${entry.label}" está fuera del rango permitido.`, { [field]: describeRange(entry) });
      }
      if (entry.maxValue !== undefined && compareAmounts(cents, parseAmount(entry.maxValue)) > 0) {
        throw new ValidationError(`El valor de "${entry.label}" está fuera del rango permitido.`, { [field]: describeRange(entry) });
      }
      return formatAmount(cents);
    }

    case "BOOL":
      if (typeof value !== "boolean") {
        throw new ValidationError(`El valor de "${entry.label}" debe ser verdadero o falso.`, { [field]: "Activa o desactiva la opción." });
      }
      return value;

    case "STRING": {
      if (typeof value !== "string" || value.trim() === "") {
        throw new ValidationError(`El valor de "${entry.label}" no puede estar vacío.`, { [field]: "Escribe un texto." });
      }
      return value.trim();
    }

    case "ENUM": {
      const options = entry.options ?? [];
      if (typeof value !== "string" || !options.includes(value)) {
        throw new ValidationError(`El valor de "${entry.label}" debe ser una de las opciones disponibles.`, { [field]: `Opciones: ${options.join(", ")}.` });
      }
      return value;
    }

    case "JSON": {
      if (value === undefined) {
        throw new ValidationError(`El valor de "${entry.label}" no tiene un formato válido.`, { [field]: "Escribe un valor JSON válido." });
      }
      // When the catalog default is a list (e.g. payments.reminder_days_before_due),
      // the value must keep that shape; anything else is accepted as JSON.
      if (Array.isArray(entry.value) && !Array.isArray(value)) {
        throw new ValidationError(`El valor de "${entry.label}" debe ser una lista.`, { [field]: "Usa una lista, por ejemplo [1, 2]." });
      }
      return value;
    }
  }
}

export function createSettingsAdminService(
  db: SettingsAdminDb,
  options: SettingsAdminOptions = {},
): SettingsAdminService {
  const assertCanEdit = (actor: SettingsActor, entry: CatalogEntry): void => {
    const rank = ROLE_RANK[actor.role] ?? -1;
    const required = ROLE_RANK[entry.editableBy] ?? Number.POSITIVE_INFINITY;
    if (rank < required) {
      throw new ForbiddenError(`Solo un usuario con rol ${entry.editableBy} puede cambiar esta configuración.`);
    }
  };

  return {
    async update(actor, changes) {
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new ValidationError("No hay cambios para guardar.");
      }
      if (changes.length > MAX_CHANGES_PER_UPDATE) {
        throw new ValidationError("Demasiados cambios en una sola operación.");
      }

      // Phase 1: validate every entry BEFORE writing anything, so a batch with
      // one bad value leaves the database untouched.
      const validated: Array<{ entry: CatalogEntry; value: unknown }> = [];
      for (const change of changes) {
        const entry = SETTINGS_CATALOG_BY_KEY.get(change.key);
        if (!entry) {
          throw new ValidationError(`"${change.key}" no es una configuración conocida.`, { [change.key]: "La clave no existe en el catálogo." });
        }
        assertCanEdit(actor, entry);
        validated.push({ entry, value: validateSettingValue(entry, change.value) });
      }

      // Phase 2: snapshot, update and audit each key.
      const results: SettingsChangeResult[] = [];
      for (const { entry, value } of validated) {
        const before = await db.$queryRaw<Array<{ value: unknown }>>`
          /* @settings:snapshot */
          SELECT value FROM settings WHERE key = ${entry.key}
        `;
        if (!before[0]) {
          throw new NotFoundError(`La configuración "${entry.key}" no existe en la base de datos.`);
        }

        await db.$executeRaw`
          /* @settings:update */
          UPDATE settings SET value = ${JSON.stringify(value)}::jsonb, updated_by = ${actor.id}::uuid, updated_at = now()
          WHERE key = ${entry.key}
        `;

        await db.$executeRaw`
          /* @settings:audit */
          INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
          VALUES (${actor.id}::uuid, 'settings.update', 'settings', ${entry.key}, ${JSON.stringify(before[0].value)}::jsonb, ${JSON.stringify(value)}::jsonb)
        `;

        options.invalidate?.(entry.key);
        results.push({ key: entry.key, before: before[0].value, after: value });
      }

      return results;
    },
  };
}
