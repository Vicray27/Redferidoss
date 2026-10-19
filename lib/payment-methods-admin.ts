// =============================================================================
// lib/payment-methods-admin.ts — §5.6/§8.5: the admin CRUD of payment_methods.
//
// The catalog is admin-configurable, but the whole app already depends on it:
// the member form picks a method by id, `createReport` reads its
// requires_reference/requires_proof flags, and the historical `method` ENUM
// column projects the code through the §5.5 vocabulary with the OTHER fallback
// (D43). That is why this service is deliberately asymmetric:
//
//   * CREATE accepts any well-formed code — it is the ONLY write that sets it.
//   * UPDATE can never change `code`: it is the stable key the enum projection
//     and every integration reads. Changing it would rewrite history.
//   * There is NO delete (the spec's API is GET/POST/PATCH only, §10.5, and
//     payment_reports.method_id is FK RESTRICT): a method that should stop
//     being offered is DEACTIVATED, so old reports keep their label.
//
// Reordering swaps adjacent positions over the full ordered list, not just the
// two rows' sort_order values: two rows may share a sort_order (the column has
// no unique constraint), and a naive swap would no-op exactly in that case.
//
// Every accepted write leaves one audit_log row (R10/A12) with before/after,
// mirroring lib/settings-admin.ts.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError } from "./authz";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface PaymentMethodsAdminDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** The actor shape the settings writer uses; `session.role` is what counts. */
export interface PaymentMethodsActor {
  id: string;
  role: string;
}

export interface PaymentMethodRow {
  id: string;
  code: string;
  label: string;
  instructions: string | null;
  requiresReference: boolean;
  requiresProof: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface NewPaymentMethod {
  code: string;
  label: string;
  instructions?: string | null;
  requiresReference?: boolean;
  requiresProof?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

/** Partial edit of an EXISTING method. `code` is absent by design (D55). */
export interface PaymentMethodUpdate {
  label?: string;
  instructions?: string | null;
  requiresReference?: boolean;
  requiresProof?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export interface MoveResult {
  id: string;
  direction: "up" | "down";
  /** False when the row already sits at the boundary of the list. */
  moved: boolean;
}

export interface PaymentMethodsAdminService {
  /** ALL methods, inactive included, ordered by sort_order then code. */
  list(actor: PaymentMethodsActor): Promise<PaymentMethodRow[]>;
  create(actor: PaymentMethodsActor, input: NewPaymentMethod): Promise<PaymentMethodRow>;
  update(actor: PaymentMethodsActor, id: string, input: PaymentMethodUpdate): Promise<PaymentMethodRow>;
  /** ↑/↓: swap the row with its adjacent neighbour in the ordered list. */
  move(actor: PaymentMethodsActor, id: string, direction: "up" | "down"): Promise<MoveResult>;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * The code vocabulary the §5.5 projection understands is
 * TRANSFER/MOBILE/ZELLE/CASH/CRYPTO/OTHER (D43). Admin codes are FREELY
 * well-formed uppercase words outside that list on purpose: the projection
 * falls back to OTHER for the historical ENUM column while `method_id` keeps
 * the custom catalog row — that is what D43 declared, and this shape is the
 * one it expects.
 */
export const METHOD_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

const LABEL_MAX = 120;
const INSTRUCTIONS_MAX = 2000;
const SORT_ORDER_MAX = 9999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unique violation in the pg driver (`23505`) or Prisma (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === "23505" || candidate.code === "P2002" || candidate.meta?.code === "23505";
}

/**
 * ValidationError with the field-keyed detail map the forms read (§10): the
 * message is what the UI shows first, `details[field]` what the field shows.
 */
function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, { [field]: message });
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("label", "Escribe la etiqueta del método de pago.");
  }
  const label = value.trim();
  if (label.length > LABEL_MAX) {
    throw invalid("label", `La etiqueta no puede superar ${LABEL_MAX} caracteres.`);
  }
  return label;
}

/** Optional text: "" becomes NULL — the column stores absence, not emptiness. */
function validateInstructions(value: unknown): string | null {
  if (typeof value !== "string") {
    throw invalid("instructions", "Escribe un texto para las instrucciones.");
  }
  const text = value.trim();
  if (text.length > INSTRUCTIONS_MAX) {
    throw invalid("instructions", `Las instrucciones no pueden superar ${INSTRUCTIONS_MAX} caracteres.`);
  }
  return text === "" ? null : text;
}

function validateBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalid(field, "Activa o desactiva la opción.");
  }
  return value;
}

function validateSortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > SORT_ORDER_MAX) {
    throw invalid("sortOrder", `Usa un número entero entre 0 y ${SORT_ORDER_MAX} para la posición.`);
  }
  return numeric;
}

/**
 * Canonical create payload. Exported because the admin screen mirrors the
 * `code` shape client-side for inline feedback; the server stays the judge.
 */
export function validateNewPaymentMethod(input: NewPaymentMethod): Required<Omit<NewPaymentMethod, "instructions">> & {
  instructions: string | null;
} {
  const label = validateLabel(input.label);
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  if (!METHOD_CODE_RE.test(code)) {
    throw invalid(
      "code",
      "El código no es válido: usa una letra inicial y luego letras, números o guion bajo (por ejemplo NEQUI).",
    );
  }
  return {
    code,
    label,
    instructions: input.instructions === undefined || input.instructions === null ? null : validateInstructions(input.instructions),
    requiresReference: validateBoolean(input.requiresReference, "requiresReference") ?? true,
    requiresProof: validateBoolean(input.requiresProof, "requiresProof") ?? false,
    isActive: validateBoolean(input.isActive, "isActive") ?? true,
    sortOrder: validateSortOrder(input.sortOrder) ?? 0,
  };
}

/** Canonical update payload: missing keys mean "keep the current value". */
export function validatePaymentMethodUpdate(input: PaymentMethodUpdate): PaymentMethodUpdate {
  const canonical: PaymentMethodUpdate = {};
  if (input.label !== undefined) {
    canonical.label = validateLabel(input.label);
  }
  if (input.instructions !== undefined) {
    canonical.instructions = input.instructions === null ? null : validateInstructions(input.instructions);
  }
  const requiresReference = validateBoolean(input.requiresReference, "requiresReference");
  if (requiresReference !== undefined) canonical.requiresReference = requiresReference;
  const requiresProof = validateBoolean(input.requiresProof, "requiresProof");
  if (requiresProof !== undefined) canonical.requiresProof = requiresProof;
  const isActive = validateBoolean(input.isActive, "isActive");
  if (isActive !== undefined) canonical.isActive = isActive;
  const sortOrder = validateSortOrder(input.sortOrder);
  if (sortOrder !== undefined) canonical.sortOrder = sortOrder;
  return canonical;
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

const ROW_COLUMNS = Prisma.sql`id, code, label, instructions,
  requires_reference AS "requiresReference", requires_proof AS "requiresProof",
  is_active AS "isActive", sort_order AS "sortOrder"`;

export function createPaymentMethodsAdminService(
  db: PaymentMethodsAdminDb,
): PaymentMethodsAdminService {
  const requireStaff = (actor: PaymentMethodsActor): void => {
    if (actor.role !== "ROOT" && actor.role !== "ADMIN") {
      throw new ForbiddenError("Solo la administración puede configurar los métodos de pago.");
    }
  };

  const audit = async (
    actor: PaymentMethodsActor,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    await db.$executeRaw`
      /* @pmadmin:audit */
      INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
      VALUES (${actor.id}::uuid, ${action}, 'payment_methods', ${entityId}, ${before === null ? null : JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
    `;
  };

  const snapshot = async (id: string): Promise<PaymentMethodRow> => {
    const rows = await db.$queryRaw<PaymentMethodRow[]>`
      /* @pmadmin:snapshot */
      SELECT ${ROW_COLUMNS} FROM payment_methods WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    if (!row) throw new NotFoundError("No se encontró el método de pago.");
    return row;
  };

  const orderedList = async (): Promise<PaymentMethodRow[]> =>
    db.$queryRaw<PaymentMethodRow[]>`
      /* @pmadmin:list */
      SELECT ${ROW_COLUMNS} FROM payment_methods ORDER BY sort_order, code
    `;

  return {
    async list(actor) {
      requireStaff(actor);
      return orderedList();
    },

    async create(actor, input) {
      requireStaff(actor);
      const canonical = validateNewPaymentMethod(input);

      // Unique pre-check for the common case; the uq_payment_methods_code
      // index is the race-proof backstop mapped below.
      const existing = await db.$queryRaw<Array<{ id: string }>>`
        /* @pmadmin:exists */
        SELECT id FROM payment_methods WHERE code = ${canonical.code}
      `;
      if (existing.length > 0) {
        throw new ConflictError("Ya existe un método de pago con ese código.", "METHOD_CODE_TAKEN");
      }

      let inserted: PaymentMethodRow[];
      try {
        inserted = await db.$queryRaw<PaymentMethodRow[]>`
          /* @pmadmin:insert */
          INSERT INTO payment_methods (code, label, instructions, requires_reference, requires_proof, is_active, sort_order)
          VALUES (
            ${canonical.code}, ${canonical.label}, ${canonical.instructions},
            ${canonical.requiresReference}, ${canonical.requiresProof},
            ${canonical.isActive}, ${canonical.sortOrder}
          )
          RETURNING ${ROW_COLUMNS}
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("Ya existe un método de pago con ese código.", "METHOD_CODE_TAKEN");
        }
        throw error;
      }
      const created = inserted[0];
      if (!created) throw new Error("payment_methods INSERT ... RETURNING returned no row");

      await audit(actor, "payment_method.create", created.id, null, created);
      return created;
    },

    async update(actor, id, input) {
      requireStaff(actor);
      if (!UUID_RE.test(id)) throw new NotFoundError("No se encontró el método de pago.");
      const canonical = validatePaymentMethodUpdate(input);

      const before = await snapshot(id);
      const after: PaymentMethodRow = {
        id: before.id,
        code: before.code, // D55: immutable — never read from the input.
        label: canonical.label ?? before.label,
        instructions: canonical.instructions === undefined ? before.instructions : canonical.instructions,
        requiresReference: canonical.requiresReference ?? before.requiresReference,
        requiresProof: canonical.requiresProof ?? before.requiresProof,
        isActive: canonical.isActive ?? before.isActive,
        sortOrder: canonical.sortOrder ?? before.sortOrder,
      };

      await db.$executeRaw`
        /* @pmadmin:update */
        UPDATE payment_methods
        SET label = ${after.label}, instructions = ${after.instructions},
            requires_reference = ${after.requiresReference}, requires_proof = ${after.requiresProof},
            is_active = ${after.isActive}, sort_order = ${after.sortOrder}
        WHERE id = ${id}::uuid
      `;

      await audit(actor, "payment_method.update", id, before, after);
      return after;
    },

    async move(actor, id, direction) {
      requireStaff(actor);
      if (!UUID_RE.test(id)) throw new NotFoundError("No se encontró el método de pago.");
      if (direction !== "up" && direction !== "down") {
        throw new ValidationError("La dirección no es válida.", { direction: "Usa subir o bajar." });
      }

      // The ordered list is the source of truth: sorting by (sort_order, code)
      // and renumbering densely keeps the panel deterministic even when two
      // rows share a sort_order (the column has no unique constraint).
      const rows = await orderedList();
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) throw new NotFoundError("No se encontró el método de pago.");

      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= rows.length) {
        return { id, direction, moved: false };
      }

      // Read the scalars BEFORE writing: the audit must describe the state the
      // actor saw, not a half-renumbered list.
      const beforeOrder = rows[index].sortOrder;

      const ordered = [...rows];
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

      for (let position = 0; position < ordered.length; position++) {
        const row = ordered[position];
        const nextOrder = position + 1;
        if (row.sortOrder === nextOrder) continue;
        await db.$executeRaw`
          /* @pmadmin:set-order */
          UPDATE payment_methods SET sort_order = ${nextOrder} WHERE id = ${row.id}::uuid
        `;
      }

      const afterOrder = ordered.findIndex((row) => row.id === id) + 1;
      await audit(actor, "payment_method.reorder", id, { sortOrder: beforeOrder }, {
        sortOrder: afterOrder,
        direction,
      });

      return { id, direction, moved: true };
    },
  };
}
