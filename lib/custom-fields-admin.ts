// =============================================================================
// lib/custom-fields-admin.ts — §8.5: the admin CRUD of custom_fields (D56).
//
// The admin defines the schema the rest of the app reads: registration renders
// `show_in_registration` USER fields, the payment form will render
// `show_in_dashboard` PAYMENT_REPORT fields, and lib/custom-fields.ts judges
// every submission against whatever this service wrote. That is why the
// identity of a field is frozen the moment it exists:
//
//   * CREATE is the ONLY write that sets `entity`, `code` and `type`.
//     VALUES reference the field by id, but the code is the form key
//     (`raw[field.code]`) and the export header, and a type flip would make
//     historical values unreadable under the new rules — the admin who needs
//     a different shape deactivates this field and creates another.
//   * There is NO delete: `custom_field_values` references the field with
//     ON DELETE CASCADE, so deleting would silently destroy member data.
//     Deactivation (`is_active = false`) is the delete.
//
// The mutable surface is label, options, flags, visible_to, regex, numeric
// ranges, default_value, sort_order and is_active — everything the admin can
// legitimately change without rewriting history. Options / regex / ranges /
// default are re-validated on every write against the FROZEN type, and the
// stored `default_value` is the canonical form the engine would accept
// (BOOL "true" → true, DECIMAL stays text).
//
// Every accepted write leaves one audit_log row (R10/A12) with before/after,
// mirroring lib/payment-methods-admin.ts.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError } from "./authz";
import { isEmptyValue, validateCustomValue } from "./custom-fields";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface CustomFieldsAdminDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** The actor shape every admin service takes; `session.role` is what counts. */
export interface CustomFieldsActor {
  id: string;
  role: string;
}

export type CustomFieldEntity = "USER" | "PAYMENT_REPORT";

/** The §5.8 CHECK list, in its declaration order. */
export const CUSTOM_FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DECIMAL",
  "DATE",
  "DATETIME",
  "BOOL",
  "SELECT",
  "MULTISELECT",
  "FILE",
  "EMAIL",
  "PHONE",
  "URL",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_VISIBILITIES = ["MEMBER", "ADMIN", "ROOT"] as const;
export type CustomFieldVisibility = (typeof CUSTOM_FIELD_VISIBILITIES)[number];

export interface CustomFieldAdminRow {
  id: string;
  entity: CustomFieldEntity;
  code: string;
  label: string;
  type: CustomFieldType;
  /** Normalized to a string array (or null) for SELECT/MULTISELECT. */
  options: string[] | null;
  isRequired: boolean;
  isUnique: boolean;
  showInRegistration: boolean;
  showInProfile: boolean;
  showInDashboard: boolean;
  visibleTo: CustomFieldVisibility | null;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
  /** Canonical jsonb default; null means "no default". */
  defaultValue: unknown;
  sortOrder: number;
  isActive: boolean;
}

export interface NewCustomField {
  entity: CustomFieldEntity;
  code: string;
  label: string;
  type: CustomFieldType;
  options?: string[] | null;
  isRequired?: boolean;
  isUnique?: boolean;
  showInRegistration?: boolean;
  showInProfile?: boolean;
  showInDashboard?: boolean;
  visibleTo?: CustomFieldVisibility | null;
  regex?: string | null;
  minNumeric?: string | number | null;
  maxNumeric?: string | number | null;
  defaultValue?: unknown;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Partial edit of an EXISTING field: every key is optional ("missing means
 * keep"). entity/code/type are absent by design — they are frozen after create.
 */
export type CustomFieldUpdate = Partial<Omit<NewCustomField, "entity" | "code" | "type">>;

export interface CustomFieldMoveResult {
  id: string;
  direction: "up" | "down";
  /** False when the row already sits at the boundary of its entity list. */
  moved: boolean;
}

export interface CustomFieldsAdminService {
  /** ALL fields, inactive included, ordered by entity, sort_order, code. */
  list(actor: CustomFieldsActor): Promise<CustomFieldAdminRow[]>;
  create(actor: CustomFieldsActor, input: NewCustomField): Promise<CustomFieldAdminRow>;
  update(actor: CustomFieldsActor, id: string, input: CustomFieldUpdate): Promise<CustomFieldAdminRow>;
  /** ↑/↓: dense renumbering inside the row's ENTITY group. */
  move(actor: CustomFieldsActor, id: string, direction: "up" | "down"): Promise<CustomFieldMoveResult>;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/** Same vocabulary as payment-method codes: uppercase words, stable keys. */
export const FIELD_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

const LABEL_MAX = 120;
const REGEX_MAX = 500;
const SORT_ORDER_MAX = 9999;
const OPTIONS_MAX = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** Types whose submission is a list of admin-defined choices. */
const CHOICE_TYPES: ReadonlySet<string> = new Set(["SELECT", "MULTISELECT"]);
/** Types where a regex pattern makes sense. */
const PATTERN_TYPES: ReadonlySet<string> = new Set(["TEXT", "TEXTAREA"]);
/** Types where numeric bounds make sense. */
const RANGE_TYPES: ReadonlySet<string> = new Set(["NUMBER", "DECIMAL"]);

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === "23505" || candidate.code === "P2002" || candidate.meta?.code === "23505";
}

function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, { [field]: message });
}

function validateBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid(field, "Activa o desactiva la opción.");
  return value;
}

function validateSortOrder(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > SORT_ORDER_MAX) {
    throw invalid("sortOrder", `Usa un número entero entre 0 y ${SORT_ORDER_MAX} para el orden.`);
  }
  return numeric;
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("label", "Escribe la etiqueta del campo.");
  }
  const label = value.trim();
  if (label.length > LABEL_MAX) {
    throw invalid("label", `La etiqueta no puede superar ${LABEL_MAX} caracteres.`);
  }
  return label;
}

/**
 * Choices arrive as a plain string array (the screen sends one per line).
 * Required — and only allowed — for SELECT/MULTISELECT: an empty choice list
 * would make the field accept anything, which is not what "SELECT" means.
 */
function validateOptions(value: unknown, type: CustomFieldType): string[] | null {
  if (!CHOICE_TYPES.has(type)) return null;
  if (!Array.isArray(value)) {
    throw invalid("options", "Agrega al menos una opción para este tipo de campo.");
  }
  const seen = new Set<string>();
  const options: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const choice = entry.trim();
    if (choice === "" || seen.has(choice)) continue;
    seen.add(choice);
    options.push(choice);
  }
  if (options.length === 0) {
    throw invalid("options", "Agrega al menos una opción para este tipo de campo.");
  }
  if (options.length > OPTIONS_MAX) {
    throw invalid("options", `No se pueden superar ${OPTIONS_MAX} opciones.`);
  }
  return options;
}

function validateRegex(value: unknown, type: CustomFieldType): string | null {
  if (!PATTERN_TYPES.has(type)) return null;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid("regex", "El patrón no es válido.");
  const pattern = value.trim();
  if (pattern === "") return null;
  if (pattern.length > REGEX_MAX) {
    throw invalid("regex", `El patrón no puede superar ${REGEX_MAX} caracteres.`);
  }
  try {
    new RegExp(pattern);
  } catch {
    throw invalid("regex", "El patrón no es una expresión regular válida.");
  }
  return pattern;
}

/** NUMERIC bounds travel as text (they never round-trip through float). */
function validateNumericBound(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!NUMERIC_RE.test(text)) {
    throw invalid(field, "Usa un número para este límite.");
  }
  return text;
}

function validateRange(
  type: CustomFieldType,
  minRaw: unknown,
  maxRaw: unknown,
): { minNumeric: string | null; maxNumeric: string | null } {
  if (!RANGE_TYPES.has(type)) return { minNumeric: null, maxNumeric: null };
  const minNumeric = validateNumericBound(minRaw, "minNumeric");
  const maxNumeric = validateNumericBound(maxRaw, "maxNumeric");
  if (minNumeric !== null && maxNumeric !== null && Number(minNumeric) > Number(maxNumeric)) {
    throw invalid("minNumeric", "El mínimo no puede ser mayor que el máximo.");
  }
  return { minNumeric, maxNumeric };
}

interface FieldShape {
  code: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
}

/**
 * The default is stored in the CANONICAL form the engine would accept, so the
 * form prefill and the server validation can never disagree. FILE fields have
 * no default: there is nothing to prefill for an upload.
 */
function validateDefaultValue(value: unknown, shape: FieldShape): unknown {
  if (shape.type === "FILE" || value === undefined || value === null || isEmptyValue(value)) {
    return null;
  }
  const verdict = validateCustomValue(shape, value);
  if (!verdict.ok) throw invalid("defaultValue", verdict.message);
  return verdict.value;
}

function validateVisibility(value: unknown): CustomFieldVisibility | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !(CUSTOM_FIELD_VISIBILITIES as readonly string[]).includes(value)
  ) {
    throw invalid("visibleTo", "Elige una visibilidad válida.");
  }
  return value as CustomFieldVisibility;
}

function validateEntity(value: unknown): CustomFieldEntity {
  if (value !== "USER" && value !== "PAYMENT_REPORT") {
    throw invalid("entity", "Elige la entidad del campo.");
  }
  return value;
}

function validateType(value: unknown): CustomFieldType {
  if (typeof value !== "string" || !(CUSTOM_FIELD_TYPES as readonly string[]).includes(value)) {
    throw invalid("type", "Elige un tipo de campo válido.");
  }
  return value as CustomFieldType;
}

/**
 * Canonical create payload. Exported because the admin screen mirrors the
 * `code` shape client-side for inline feedback; the server stays the judge.
 */
export function validateNewCustomField(input: NewCustomField): Omit<CustomFieldAdminRow, "id"> {
  const entity = validateEntity(input.entity);
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  if (!FIELD_CODE_RE.test(code)) {
    throw invalid(
      "code",
      "El código no es válido: usa una letra inicial y luego letras, números o guion bajo (por ejemplo BARRIO).",
    );
  }
  const label = validateLabel(input.label);
  const type = validateType(input.type);
  const shape: FieldShape = {
    code,
    label,
    type,
    options: validateOptions(input.options, type),
    regex: validateRegex(input.regex, type),
    minNumeric: null,
    maxNumeric: null,
  };
  const range = validateRange(type, input.minNumeric, input.maxNumeric);
  shape.minNumeric = range.minNumeric;
  shape.maxNumeric = range.maxNumeric;
  return {
    entity,
    code,
    label,
    type,
    options: shape.options,
    isRequired: validateBoolean(input.isRequired, "isRequired", false),
    // A unique constraint over opaque uploads is meaningless; force it off.
    isUnique: type === "FILE" ? false : validateBoolean(input.isUnique, "isUnique", false),
    showInRegistration: validateBoolean(input.showInRegistration, "showInRegistration", false),
    showInProfile: validateBoolean(input.showInProfile, "showInProfile", false),
    showInDashboard: validateBoolean(input.showInDashboard, "showInDashboard", false),
    visibleTo: validateVisibility(input.visibleTo),
    regex: shape.regex,
    minNumeric: shape.minNumeric,
    maxNumeric: shape.maxNumeric,
    defaultValue: validateDefaultValue(input.defaultValue, shape),
    sortOrder: validateSortOrder(input.sortOrder, 0),
    isActive: validateBoolean(input.isActive, "isActive", true),
  };
}

/**
 * Canonical update payload: missing keys mean "keep the current value", so the
 * result only carries the keys the caller actually sent and the service merges
 * it over the snapshot. entity/code/type are frozen (header comment); the shape
 * used to validate options/regex/ranges/default is the CURRENT one, never a
 * client-supplied one.
 */
export type CustomFieldUpdateCanonical = Partial<
  Omit<CustomFieldAdminRow, "id" | "entity" | "code" | "type">
>;

export function validateCustomFieldUpdate(
  input: CustomFieldUpdate,
  current: Pick<
    CustomFieldAdminRow,
    "code" | "type" | "label" | "options" | "regex" | "minNumeric" | "maxNumeric"
  >,
): CustomFieldUpdateCanonical {
  const canonical: CustomFieldUpdateCanonical = {};

  if (input.label !== undefined) canonical.label = validateLabel(input.label);
  if (input.options !== undefined) canonical.options = validateOptions(input.options, current.type);
  if (input.isRequired !== undefined) canonical.isRequired = validateBoolean(input.isRequired, "isRequired", false);
  // A unique constraint over opaque uploads is meaningless; FILE stays false.
  if (current.type === "FILE") canonical.isUnique = false;
  else if (input.isUnique !== undefined) canonical.isUnique = validateBoolean(input.isUnique, "isUnique", false);
  if (input.showInRegistration !== undefined) {
    canonical.showInRegistration = validateBoolean(input.showInRegistration, "showInRegistration", false);
  }
  if (input.showInProfile !== undefined) {
    canonical.showInProfile = validateBoolean(input.showInProfile, "showInProfile", false);
  }
  if (input.showInDashboard !== undefined) {
    canonical.showInDashboard = validateBoolean(input.showInDashboard, "showInDashboard", false);
  }
  if (input.visibleTo !== undefined) canonical.visibleTo = validateVisibility(input.visibleTo);
  if (input.regex !== undefined) canonical.regex = validateRegex(input.regex, current.type);

  if (input.minNumeric !== undefined || input.maxNumeric !== undefined) {
    const minRaw = input.minNumeric === undefined ? current.minNumeric : input.minNumeric;
    const maxRaw = input.maxNumeric === undefined ? current.maxNumeric : input.maxNumeric;
    const range = validateRange(current.type, minRaw, maxRaw);
    canonical.minNumeric = range.minNumeric;
    canonical.maxNumeric = range.maxNumeric;
  }

  if (input.defaultValue !== undefined) {
    // The default is judged against the POST-update shape (new label included)
    // so its validation message names what the admin is looking at.
    const shape: FieldShape = {
      code: current.code,
      label: canonical.label ?? current.label,
      type: current.type,
      options: canonical.options ?? current.options,
      regex: canonical.regex ?? current.regex,
      minNumeric: canonical.minNumeric ?? current.minNumeric,
      maxNumeric: canonical.maxNumeric ?? current.maxNumeric,
    };
    canonical.defaultValue = validateDefaultValue(input.defaultValue, shape);
  }

  if (input.sortOrder !== undefined) canonical.sortOrder = validateSortOrder(input.sortOrder, 0);
  if (input.isActive !== undefined) canonical.isActive = validateBoolean(input.isActive, "isActive", false);

  return canonical;
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

const ROW_COLUMNS = Prisma.sql`id, entity, code, label, type, options,
  is_required AS "isRequired", is_unique AS "isUnique",
  show_in_registration AS "showInRegistration", show_in_profile AS "showInProfile",
  show_in_dashboard AS "showInDashboard", visible_to AS "visibleTo",
  regex, min_numeric::text AS "minNumeric", max_numeric::text AS "maxNumeric",
  default_value AS "defaultValue", sort_order AS "sortOrder", is_active AS "isActive"`;

export function createCustomFieldsAdminService(db: CustomFieldsAdminDb): CustomFieldsAdminService {
  const requireStaff = (actor: CustomFieldsActor): void => {
    if (actor.role !== "ROOT" && actor.role !== "ADMIN") {
      throw new ForbiddenError("Solo la administración puede configurar los campos personalizados.");
    }
  };

  const audit = async (
    actor: CustomFieldsActor,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    await db.$executeRaw`
      /* @cfadmin:audit */
      INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
      VALUES (${actor.id}::uuid, ${action}, 'custom_fields', ${entityId}, ${before === null ? null : JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
    `;
  };

  const orderedList = async (): Promise<CustomFieldAdminRow[]> =>
    db.$queryRaw<CustomFieldAdminRow[]>`
      /* @cfadmin:list */
      SELECT ${ROW_COLUMNS} FROM custom_fields ORDER BY entity, sort_order, code
    `;

  const snapshot = async (id: string): Promise<CustomFieldAdminRow> => {
    const rows = await db.$queryRaw<CustomFieldAdminRow[]>`
      /* @cfadmin:snapshot */
      SELECT ${ROW_COLUMNS} FROM custom_fields WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) throw new NotFoundError("No se encontró el campo personalizado.");
    return row;
  };

  return {
    async list(actor) {
      requireStaff(actor);
      return orderedList();
    },

    async create(actor, input) {
      requireStaff(actor);
      const canonical = validateNewCustomField(input);

      // Unique pre-check for the common case; uq_custom_fields_entity_code is
      // the race-proof backstop mapped below.
      const existing = await db.$queryRaw<Array<{ id: string }>>`
        /* @cfadmin:exists */
        SELECT id FROM custom_fields WHERE entity = ${canonical.entity} AND code = ${canonical.code}
      `;
      if (existing.length > 0) {
        throw new ConflictError("Ya existe un campo con ese código.", "FIELD_CODE_TAKEN");
      }

      const optionsJson = canonical.options === null ? null : JSON.stringify(canonical.options);
      const defaultJson =
        canonical.defaultValue === null ? null : JSON.stringify(canonical.defaultValue);

      let inserted: CustomFieldAdminRow[];
      try {
        inserted = await db.$queryRaw<CustomFieldAdminRow[]>`
          /* @cfadmin:insert */
          INSERT INTO custom_fields (
            entity, code, label, type, options, is_required, is_unique,
            show_in_registration, show_in_profile, show_in_dashboard, visible_to,
            regex, min_numeric, max_numeric, default_value, sort_order, is_active
          )
          VALUES (
            ${canonical.entity}, ${canonical.code}, ${canonical.label}, ${canonical.type},
            ${optionsJson}::jsonb, ${canonical.isRequired}, ${canonical.isUnique},
            ${canonical.showInRegistration}, ${canonical.showInProfile}, ${canonical.showInDashboard},
            ${canonical.visibleTo}::user_role,
            ${canonical.regex}, ${canonical.minNumeric}::numeric, ${canonical.maxNumeric}::numeric,
            ${defaultJson}::jsonb, ${canonical.sortOrder}, ${canonical.isActive}
          )
          RETURNING ${ROW_COLUMNS}
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("Ya existe un campo con ese código.", "FIELD_CODE_TAKEN");
        }
        throw error;
      }
      const created = inserted[0];
      if (!created) throw new Error("custom_fields INSERT ... RETURNING returned no row");

      await audit(actor, "custom_field.create", created.id, null, created);
      return created;
    },

    async update(actor, id, input) {
      requireStaff(actor);
      if (!UUID_RE.test(id)) throw new NotFoundError("No se encontró el campo personalizado.");

      const before = await snapshot(id);
      // Missing keys keep the snapshot value: the SQL writes the merged row,
      // never a half-defaulted one.
      const after: CustomFieldAdminRow = { ...before, ...validateCustomFieldUpdate(input, before) };

      const optionsJson = after.options === null ? null : JSON.stringify(after.options);
      const defaultJson = after.defaultValue === null ? null : JSON.stringify(after.defaultValue);

      await db.$executeRaw`
        /* @cfadmin:update */
        UPDATE custom_fields
        SET label = ${after.label},
            options = ${optionsJson}::jsonb,
            is_required = ${after.isRequired},
            is_unique = ${after.isUnique},
            show_in_registration = ${after.showInRegistration},
            show_in_profile = ${after.showInProfile},
            show_in_dashboard = ${after.showInDashboard},
            visible_to = ${after.visibleTo}::user_role,
            regex = ${after.regex},
            min_numeric = ${after.minNumeric}::numeric,
            max_numeric = ${after.maxNumeric}::numeric,
            default_value = ${defaultJson}::jsonb,
            sort_order = ${after.sortOrder},
            is_active = ${after.isActive},
            updated_at = now()
        WHERE id = ${id}::uuid
      `;

      await audit(actor, "custom_field.update", id, before, after);
      return after;
    },

    async move(actor, id, direction) {
      requireStaff(actor);
      if (!UUID_RE.test(id)) throw new NotFoundError("No se encontró el campo personalizado.");
      if (direction !== "up" && direction !== "down") {
        throw new ValidationError("La dirección no es válida.", { direction: "Usa subir o bajar." });
      }

      const rows = await orderedList();
      const target = rows.find((row) => row.id === id);
      if (!target) throw new NotFoundError("No se encontró el campo personalizado.");

      // Renumber inside the ENTITY group only: the panel shows two lists
      // (USER / PAYMENT_REPORT) and moving across them would be meaningless.
      const group = rows.filter((row) => row.entity === target.entity);
      const index = group.findIndex((row) => row.id === id);
      const neighbour = direction === "up" ? index - 1 : index + 1;
      if (neighbour < 0 || neighbour >= group.length) {
        return { id, direction, moved: false };
      }

      // Read the scalar BEFORE writing: the audit describes what the actor saw.
      const beforeOrder = group[index].sortOrder;

      const ordered = [...group];
      [ordered[index], ordered[neighbour]] = [ordered[neighbour], ordered[index]];

      for (let position = 0; position < ordered.length; position++) {
        const row = ordered[position];
        const nextOrder = position + 1;
        if (row.sortOrder === nextOrder) continue;
        await db.$executeRaw`
          /* @cfadmin:set-order */
          UPDATE custom_fields SET sort_order = ${nextOrder}, updated_at = now() WHERE id = ${row.id}::uuid
        `;
      }

      const afterOrder = ordered.findIndex((row) => row.id === id) + 1;
      await audit(actor, "custom_field.reorder", id, { sortOrder: beforeOrder }, {
        sortOrder: afterOrder,
        direction,
      });

      return { id, direction, moved: true };
    },
  };
}
