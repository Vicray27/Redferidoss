// =============================================================================
// lib/payments.ts — §5.5 payment reports: the weekly offering.
//
// One report per person per cycle — the SQL partial unique index
// uq_report_user_cycle (D4) enforces it while max_reports_per_cycle = 1 —
// reviewed by ADMIN/ROOT, and an APPROVED report is what fulfils the person's
// cycle_obligations row. Every business rule comes from settings
// (amount_mode, expected_amount, currency, allow_backdated_days, auto_approve,
// require_proof, require_reference); "one report per week" is a setting, not a
// constant.
//
// D43 records the composed rules:
//   * reference is required when BOTH payments.require_reference and the
//     chosen method's flag are true (§6: "según el método elegido");
//   * proof is required when EITHER payments.require_proof or the method flag
//     is true (§6: "obligatorio en cada reporte");
//   * the report window is the cycle currently inside [starts_at, due_at):
//     no retroactive reports once due_at passed, and a REJECTED report may be
//     replaced only while that window is open.
//
// The `method` column is the payment_method ENUM (fixed vocabulary, SQL-only):
// the admin-configurable code travels in `method_id` and is projected into the
// enum through the §5.5 vocabulary, falling back to 'OTHER' for custom methods
// so the historical text column never rejects an admin-defined method.
//
// Errors are AppError subclasses: 400 ValidationError with a field-keyed
// `details` map, 403 ForbiddenError, 404 NotFoundError, 409 ConflictError.
//
// D39/D40: `downlineOfferings` (bottom) serves the member face — direct
// invitees, the FACT of their offering, and the amount only while
// visibility.member_sees_downline_amounts is on.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError, type SessionActor } from "./authz";
import {
  assertCustomValuesUnique,
  collectCustomValues,
  type CustomFieldRow,
} from "./custom-fields";
import { MS_PER_DAY } from "./cycles";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { compareAmounts, formatAmount, parseAmount } from "./money";
import type { SettingsReader } from "./settings";

/** The narrower surface a transaction callback receives (D57). */
export interface PaymentsTx {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface PaymentsDb extends PaymentsTx {
  /**
   * Interactive transaction. `createReport` commits the report row and its
   * `custom_field_values` as one unit: a unique clash or a bad value rolls the
   * report back instead of leaving a half-written submission (D57).
   */
  $transaction<T>(fn: (tx: PaymentsTx) => Promise<T>): Promise<T>;
}

/** Settings subset the service depends on — injectable in tests. */
export type PaymentsSettings = Pick<SettingsReader, "getOrThrow">;

/** Authorization surface the downline read needs (lib/authz satisfies it). */
export interface PaymentsAuthz {
  scopeFilter(actor: SessionActor, options?: { alias?: string }): Promise<{ fragment: Prisma.Sql; unrestricted: boolean }>;
}

export type ReportStatus = "PENDING" | "APPROVED" | "REJECTED";
export type ReviewDecision = "APPROVED" | "REJECTED";
export type AmountMode = "FIXED" | "MINIMUM" | "FREE";

export interface PaymentsActor {
  id: string;
  role: string;
}

export interface CreateReportInput {
  amount: string | number;
  methodId: string;
  reference?: string | null;
  /** Date, or an ISO string from a form submission. */
  paidAt: Date | string;
  note?: string | null;
  proofKey?: string | null;
  /** Values keyed by custom field `code` (PAYMENT_REPORT fields, §17/F6). */
  custom?: Record<string, unknown> | null;
}

export interface CreatedReport {
  id: string;
  status: ReportStatus;
  cycleId: string;
  periodKey: string;
  reportedAt: Date;
}

export interface ReviewedReport {
  id: string;
  status: ReviewDecision;
  userId: string;
  cycleId: string;
}

/** Why one item of a bulk action was skipped (D52). */
export type BulkReviewSkipReason = "already_reviewed" | "not_found";

export interface BulkReviewSkipped {
  reportId: string;
  reason: BulkReviewSkipReason;
  message: string;
}

export interface BulkReviewResult {
  /** Distinct, well-formed ids the action considered. */
  total: number;
  approved: number;
  rejected: number;
  skipped: BulkReviewSkipped[];
}

/** Why one item of a cycle reassignment was skipped (D52). */
export type BulkReassignSkipReason =
  | "not_found"
  | "not_pending"
  | "already_in_target"
  | "duplicate_in_target";

export interface BulkReassignSkipped {
  reportId: string;
  reason: BulkReassignSkipReason;
  message: string;
}

export interface BulkReassignResult {
  total: number;
  moved: number;
  skipped: BulkReassignSkipped[];
  target: { id: string; periodKey: string };
}

/** §8.5 bulk actions operate on at most this many ids per call (D52). */
export const BULK_MAX_IDS = 500;

export interface MyReportRow {
  id: string;
  amount: string;
  currency: string;
  method: string;
  status: ReportStatus;
  paidAt: Date;
  reportedAt: Date;
  reviewNote: string | null;
  proofKey: string | null;
  cycleId: string;
  periodKey: string;
}

export interface ReviewQueueRow {
  id: string;
  amount: string;
  currency: string;
  method: string;
  paidAt: Date;
  reportedAt: Date;
  note: string | null;
  proofKey: string | null;
  reference: string | null;
  userId: string;
  fullName: string;
  publicCode: string;
  cycleId: string;
  periodKey: string;
  /** PAYMENT_REPORT custom values of the submission, label + raw jsonb. */
  customValues: Array<{ label: string; value: unknown }>;
}

/** A direct invitee and the fact of their offering inside a cycle (D39). */
export interface DownlineOfferingRow {
  userId: string; fullName: string; publicCode: string; hasOffering: boolean;
  /** Present only when visibility.member_sees_downline_amounts is true. */
  amount?: string; currency?: string;
}

export interface PaymentsService {
  createReport(actor: PaymentsActor, input: CreateReportInput): Promise<CreatedReport>;
  reviewReport(actor: PaymentsActor, reportId: string, decision: ReviewDecision, note?: string | null): Promise<ReviewedReport>;
  /** §8.5 "acciones en lote": approve/reject many at once, per-item results. */
  reviewMany(actor: PaymentsActor, reportIds: readonly string[], decision: ReviewDecision, note?: string | null): Promise<BulkReviewResult>;
  /** §8.5 "acciones en lote": move PENDING reports to another cycle. */
  reassignReports(actor: PaymentsActor, reportIds: readonly string[], targetCycleId: string): Promise<BulkReassignResult>;
  listMyReports(actor: PaymentsActor, options?: { limit?: number }): Promise<MyReportRow[]>;
  /** Staff-only (root cause of S4): the queue exposes amounts and references. */
  listReviewQueue(actor: PaymentsActor, options?: { limit?: number; cycleId?: string }): Promise<ReviewQueueRow[]>;
  /** §8.4/D39: the actor's direct invitees and their offering for a cycle. */
  downlineOfferings(actor: SessionActor, options: { cycleId: string; limit?: number }): Promise<DownlineOfferingRow[]>;
}

export interface PaymentsServiceOptions {
  now?: () => Date;
}

/** The six codes of the SQL `payment_method` enum (§5.5 comment in 0001_init). */
const METHOD_ENUM_CODES = ["TRANSFER", "MOBILE", "ZELLE", "CASH", "CRYPTO"] as const;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETTING_KEYS = {
  amountMode: "payments.amount_mode",
  expectedAmount: "payments.expected_amount",
  currency: "payments.currency",
  allowBackdatedDays: "payments.allow_backdated_days",
  autoApprove: "payments.auto_approve",
  requireProof: "payments.require_proof",
  requireReference: "payments.require_reference",
  memberSeesDownlineAmounts: "visibility.member_sees_downline_amounts",
} as const;

/** Unique violation in the pg driver (`23505`) or Prisma (`P2002`). */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === "23505" || candidate.code === "P2002" || candidate.meta?.code === "23505";
}

interface CycleRow {
  id: string;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  due_at: Date;
}

interface MethodRow {
  id: string;
  code: string;
  requires_reference: boolean;
  requires_proof: boolean;
}

interface AuthorSnapshotRow {
  path: string;
  depth: number;
}

interface DownlineOfferingRawRow {
  userId: string; fullName: string; publicCode: string; reportId: string | null; amount: string | null; currency: string | null;
}

export function createPaymentsService(
  db: PaymentsDb,
  settings: PaymentsSettings,
  authz: PaymentsAuthz,
  options: PaymentsServiceOptions = {},
): PaymentsService {
  const now = options.now ?? (() => new Date());

  const clampLimit = (raw: number | undefined): number => {
    if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIST_LIMIT;
    return Math.min(Math.max(1, Math.trunc(raw)), MAX_LIST_LIMIT);
  };

  const fulfilObligation = async (cycleId: string, userId: string, reportId: string): Promise<void> => {
    await db.$executeRaw`
      /* @pay:fulfil-obligation */
      UPDATE cycle_obligations SET status = 'FULFILLED', fulfilled_report_id = ${reportId}::uuid
      WHERE cycle_id = ${cycleId}::uuid AND user_id = ${userId}::uuid AND status <> 'FULFILLED'
    `;
  };

  const notifyReview = async (userId: string, input: { reportId: string; cycleId: string; status: ReportStatus; note: string | null }): Promise<void> => {
    const approved = input.status === "APPROVED";
    const title = approved ? "Aporte aprobado" : "Aporte rechazado";
    const body = approved ? "Tu aporte de la semana fue aprobado." : `Tu aporte fue rechazado: ${input.note ?? "revisa el detalle."}`;
    await db.$executeRaw`
      /* @pay:notify-review */
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES (${userId}::uuid, 'payment.reviewed', ${title}, ${body}, ${JSON.stringify({ reportId: input.reportId, cycleId: input.cycleId, status: input.status })}::jsonb)
    `;
  };

  const requireStaff = (actor: PaymentsActor): void => {
    if (actor.role !== "ROOT" && actor.role !== "ADMIN") {
      throw new ForbiddenError("Solo la administración puede revisar aportes.");
    }
  };

  const assertDecision: (decision: string) => asserts decision is ReviewDecision = (decision) => {
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      throw new ValidationError("La decisión no es válida.", { decision: "Aprueba o rechaza el reporte." });
    }
  };

  /**
   * The single review, exactly as /admin/revisiones always did it. Bulk review
   * loops THIS: one code path means the audit fields, the obligation sync and
   * the notification are identical for one item or for five hundred (D52).
   */
  const reviewOne = async (
    actor: PaymentsActor,
    reportId: string,
    decision: ReviewDecision,
    note: string | null,
  ): Promise<ReviewedReport> => {
    const reports = await db.$queryRaw<Array<{ id: string; user_id: string; cycle_id: string; status: ReportStatus }>>`
      /* @pay:report-for-review */
      SELECT id, user_id, cycle_id, status FROM payment_reports WHERE id = ${reportId}::uuid
    `;
    const report = reports[0];
    if (!report) {
      throw new NotFoundError("No se encontró el reporte.");
    }
    if (report.status !== "PENDING") {
      throw new ConflictError("Este reporte ya fue revisado.", "REPORT_ALREADY_REVIEWED");
    }

    const reviewNote = note?.trim() ? note.trim() : null;
    if (decision === "REJECTED" && reviewNote === null) {
      throw new ValidationError("Indica el motivo del rechazo.", { reviewNote: "Escribe el motivo para que la persona pueda corregir." });
    }

    const updated = await db.$queryRaw<Array<{ id: string; user_id: string; cycle_id: string }>>`
      /* @pay:review-update */
      UPDATE payment_reports
      SET status = ${decision}::report_status, reviewed_by = ${actor.id}::uuid, reviewed_at = now(), review_note = ${reviewNote}
      WHERE id = ${reportId}::uuid AND status = 'PENDING'
      RETURNING id, user_id, cycle_id
    `;
    const reviewed = updated[0];
    if (!reviewed) {
      // Lost the race against another reviewer between SELECT and UPDATE.
      throw new ConflictError("Este reporte ya fue revisado.", "REPORT_ALREADY_REVIEWED");
    }

    if (decision === "APPROVED") {
      await fulfilObligation(reviewed.cycle_id, reviewed.user_id, reviewed.id);
    }
    await notifyReview(reviewed.user_id, { reportId: reviewed.id, cycleId: reviewed.cycle_id, status: decision, note: reviewNote });

    return { id: reviewed.id, status: decision, userId: reviewed.user_id, cycleId: reviewed.cycle_id };
  };

  const uniqueIds = (raw: readonly string[]): string[] => [...new Set(raw)];

  const assertBulkIds = (ids: readonly string[]): string[] => {
    if (ids.length === 0) {
      throw new ValidationError("No seleccionaste ningún aporte.");
    }
    if (ids.length > BULK_MAX_IDS) {
      throw new ValidationError(`Puedes procesar hasta ${BULK_MAX_IDS} aportes a la vez.`);
    }
    return uniqueIds(ids);
  };

  return {
    async createReport(actor, input) {
      const [amountMode, expectedRaw, currency, backdatedDays, autoApprove, globalProof, globalReference] = await Promise.all([
        settings.getOrThrow<AmountMode>(SETTING_KEYS.amountMode),
        settings.getOrThrow<unknown>(SETTING_KEYS.expectedAmount),
        settings.getOrThrow<string>(SETTING_KEYS.currency),
        settings.getOrThrow<number>(SETTING_KEYS.allowBackdatedDays),
        settings.getOrThrow<boolean>(SETTING_KEYS.autoApprove),
        settings.getOrThrow<boolean>(SETTING_KEYS.requireProof),
        settings.getOrThrow<boolean>(SETTING_KEYS.requireReference),
      ]);

      // --- amount: exact DECIMAL arithmetic, mode enforced from settings ------
      let amountCents: bigint;
      try {
        amountCents = parseAmount(input.amount);
      } catch {
        throw new ValidationError("El monto no es válido.", { amount: "Usa un número con hasta 2 decimales." });
      }
      if (amountCents <= 0n) {
        throw new ValidationError("El monto debe ser mayor que cero.", { amount: "Usa un número con hasta 2 decimales." });
      }
      const expectedCents = parseAmount(expectedRaw);
      const comparison = compareAmounts(amountCents, expectedCents);
      if (amountMode === "FIXED" && comparison !== 0) {
        throw new ValidationError(`El monto debe ser exactamente ${formatAmount(expectedCents)}.`, { amount: "El monto no coincide con el esperado." });
      }
      if (amountMode === "MINIMUM" && comparison < 0) {
        throw new ValidationError(`El monto debe ser al menos ${formatAmount(expectedCents)}.`, { amount: "El monto está por debajo del mínimo." });
      }

      // --- paid_at: never in the future, never older than allow_backdated_days
      const paidAt = input.paidAt instanceof Date ? input.paidAt : new Date(input.paidAt);
      if (Number.isNaN(paidAt.getTime())) {
        throw new ValidationError("La fecha de pago no es válida.", { paidAt: "Indica una fecha válida." });
      }
      const nowDate = now();
      if (paidAt.getTime() > nowDate.getTime()) {
        throw new ValidationError("La fecha de pago no puede estar en el futuro.", { paidAt: "La fecha de pago no puede estar en el futuro." });
      }
      const startOfTodayUtc = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
      const oldestAllowed = startOfTodayUtc - Math.max(0, Math.trunc(backdatedDays)) * MS_PER_DAY;
      if (paidAt.getTime() < oldestAllowed) {
        throw new ValidationError(`La fecha de pago no puede ser anterior a ${Math.trunc(backdatedDays)} días.`, { paidAt: "La fecha de pago es demasiado antigua." });
      }

      // --- report window: the cycle currently inside [starts_at, due_at) ------
      // A stored CLOSED is terminal (D37, mirrors isReportable): if an admin
      // closes a cycle while its window is still open, no report may enter it.
      const cycles = await db.$queryRaw<CycleRow[]>`
        /* @pay:cycle-window */
        SELECT id, period_key, starts_at, ends_at, due_at
        FROM payment_cycles
        WHERE starts_at <= ${nowDate} AND ${nowDate} < due_at AND status <> 'CLOSED'
        ORDER BY starts_at DESC
        LIMIT 1
      `;
      const cycle = cycles[0];
      if (!cycle) {
        throw new ConflictError("No hay una semana abierta para reportar. Intenta cuando comience el próximo ciclo.", "NO_REPORT_WINDOW");
      }

      // --- method: must exist and be active ------------------------------------
      const methods = await db.$queryRaw<MethodRow[]>`
        /* @pay:method */
        SELECT id, code, requires_reference, requires_proof
        FROM payment_methods
        WHERE id = ${input.methodId}::uuid AND is_active
      `;
      const method = methods[0];
      if (!method) {
        throw new ValidationError("El método de pago no existe o ya no está disponible.", { methodId: "Elige un método de pago activo." });
      }

      // --- D43: reference = global AND method; proof = global OR method -------
      const reference = input.reference?.trim() ? input.reference.trim() : null;
      if (globalReference && method.requires_reference && reference === null) {
        throw new ValidationError("La referencia de pago es obligatoria para este método.", { reference: "Ingresa el número de referencia o hash de la transacción." });
      }
      const proofKey = input.proofKey?.trim() ? input.proofKey.trim() : null;
      if ((globalProof || method.requires_proof) && proofKey === null) {
        throw new ValidationError("El comprobante es obligatorio para este método.", { proof: "Adjunta la imagen o el PDF del comprobante." });
      }
      if (proofKey !== null) {
        const owned = await db.$queryRaw<Array<{ owner_id: string | null }>>`
          /* @pay:proof-owner */
          SELECT owner_id FROM files WHERE key = ${proofKey}
        `;
        if (!owned[0] || owned[0].owner_id !== actor.id) {
          throw new ValidationError("El comprobante adjunto no es válido.", { proof: "Vuelve a subir el archivo." });
        }
      }

      // --- one report per cycle (D4), with the index as the backstop ----------
      const existing = await db.$queryRaw<Array<{ id: string }>>`
        /* @pay:existing-report */
        SELECT id FROM payment_reports
        WHERE user_id = ${actor.id}::uuid AND cycle_id = ${cycle.id}::uuid AND status <> 'REJECTED'
        LIMIT 1
      `;
      if (existing[0]) {
        throw new ConflictError("Ya registraste un aporte para esta semana.", "REPORT_ALREADY_EXISTS");
      }

      const authors = await db.$queryRaw<AuthorSnapshotRow[]>`
        /* @pay:author-snapshot */
        SELECT path::text AS path, depth FROM users WHERE id = ${actor.id}::uuid
      `;
      const author = authors[0];
      if (!author) {
        throw new NotFoundError("No se encontró tu usuario.");
      }

      const note = input.note?.trim() ? input.note.trim() : null;
      const status: ReportStatus = autoApprove ? "APPROVED" : "PENDING";
      const methodKind = METHOD_ENUM_CODES.includes(method.code as (typeof METHOD_ENUM_CODES)[number]) ? method.code : "OTHER";

      // --- write phase: report + custom values in ONE transaction (D57) -------
      // The PAYMENT_REPORT definitions are re-read INSIDE the transaction (the
      // client is never trusted with the rules), the collected values are
      // validated against them, and the unique check runs after the report row
      // exists — so a clash or an invalid value rolls the whole report back
      // instead of leaving a submission without its data.
      let report: { id: string; reported_at: Date };
      try {
        report = await db.$transaction(async (tx) => {
          const customFields = await tx.$queryRaw<CustomFieldRow[]>`
            /* @pay:custom-fields */
            SELECT id, code, label, type, options,
                   is_required AS "isRequired", is_unique AS "isUnique",
                   regex, min_numeric::text AS "minNumeric", max_numeric::text AS "maxNumeric"
            FROM custom_fields
            WHERE entity = 'PAYMENT_REPORT' AND is_active
            ORDER BY sort_order, code
          `;
          const collected = collectCustomValues(customFields, input.custom ?? {});
          if (Object.keys(collected.errors).length > 0) {
            throw new ValidationError("Revisa los campos del formulario.", collected.errors);
          }

          const inserted = await tx.$queryRaw<Array<{ id: string; reported_at: Date }>>`
            /* @pay:insert-report */
            INSERT INTO payment_reports
              (user_id, cycle_id, amount, currency, method, method_id, reference, paid_at, note, proof_key, status, snapshot_depth, snapshot_path)
            VALUES
              (${actor.id}::uuid, ${cycle.id}::uuid, ${formatAmount(amountCents)}::numeric(14,2), ${currency}, ${methodKind}::payment_method,
               ${method.id}::uuid, ${reference}, ${paidAt}, ${note}, ${proofKey}, ${status}::report_status, ${author.depth}, ${author.path}::ltree)
            RETURNING id, reported_at
          `;
          const row = inserted[0];
          if (!row) {
            // INSERT ... RETURNING always returns a row; a missing one is a bug.
            throw new Error("payment_reports INSERT ... RETURNING returned no row");
          }

          // The report id is the entity_id of every value: the values belong to
          // the SUBMISSION, so a rejected report keeps its history.
          await assertCustomValuesUnique(tx, collected.values, row.id);
          for (const entry of collected.values) {
            await tx.$executeRaw`
              /* @pay:custom-value */
              INSERT INTO custom_field_values (field_id, entity_id, value)
              VALUES (${entry.field.id}::uuid, ${row.id}::uuid, ${JSON.stringify(entry.value)}::jsonb)
            `;
          }
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("Ya registraste un aporte para esta semana.", "REPORT_ALREADY_EXISTS");
        }
        throw error;
      }

      // Auto-approval (payments.auto_approve) fulfils the obligation at once,
      // exactly as a manual APPROVED review would.
      if (status === "APPROVED") {
        await fulfilObligation(cycle.id, actor.id, report.id);
        await notifyReview(actor.id, { reportId: report.id, cycleId: cycle.id, status, note: null });
      }

      return { id: report.id, status, cycleId: cycle.id, periodKey: cycle.period_key, reportedAt: report.reported_at };
    },

    async reviewReport(actor, reportId, decision, note) {
      requireStaff(actor);
      assertDecision(decision);
      return reviewOne(actor, reportId, decision, note ?? null);
    },

    async reviewMany(actor, reportIds, decision, note) {
      requireStaff(actor);
      assertDecision(decision);

      const reviewNote = note?.trim() ? note.trim() : null;
      // One shared reason: a rejection without it is a form error, not five
      // hundred per-item failures.
      if (decision === "REJECTED" && reviewNote === null) {
        throw new ValidationError("Indica el motivo del rechazo.", { reviewNote: "Escribe el motivo para que la persona pueda corregir." });
      }

      const ids = assertBulkIds(reportIds);
      const skipped: BulkReviewSkipped[] = [];
      let approved = 0;
      let rejected = 0;

      // Sequential on purpose (D52): per-item isolation with bounded load.
      for (const reportId of ids) {
        if (!UUID_RE.test(reportId)) {
          skipped.push({ reportId, reason: "not_found", message: "No se encontró el reporte." });
          continue;
        }
        try {
          const reviewed = await reviewOne(actor, reportId, decision, reviewNote);
          if (reviewed.status === "APPROVED") approved += 1;
          else rejected += 1;
        } catch (error) {
          if (error instanceof ConflictError) {
            skipped.push({ reportId, reason: "already_reviewed", message: error.message });
            continue;
          }
          if (error instanceof NotFoundError) {
            skipped.push({ reportId, reason: "not_found", message: error.message });
            continue;
          }
          // Anything else is a real failure: abort the batch, report the cause.
          throw error;
        }
      }

      return { total: ids.length, approved, rejected, skipped };
    },

    async reassignReports(actor, reportIds, targetCycleId) {
      // Moving a report between weeks is a ledger correction: staff only.
      requireStaff(actor);
      if (!UUID_RE.test(targetCycleId)) {
        throw new ValidationError("La semana destino no es válida.", { targetCycleId: "Selecciona una semana." });
      }

      const cycles = await db.$queryRaw<Array<{ id: string; period_key: string }>>`
        /* @pay:cycle-target */
        SELECT id, period_key FROM payment_cycles WHERE id = ${targetCycleId}::uuid
      `;
      const target = cycles[0];
      if (!target) {
        throw new NotFoundError("No se encontró la semana destino.");
      }

      const ids = assertBulkIds(reportIds);
      const skipped: BulkReassignSkipped[] = [];
      let moved = 0;

      for (const reportId of ids) {
        if (!UUID_RE.test(reportId)) {
          skipped.push({ reportId, reason: "not_found", message: "No se encontró el reporte." });
          continue;
        }
        try {
          // PENDING-only (D52): an APPROVED report is already history — its
          // obligation fulfilment points at it and CANNOT be rewritten. Only
          // the same-cycle no-op is filtered out here so it classifies below.
          const updated = await db.$queryRaw<Array<{ id: string }>>`
            /* @pay:reassign */
            UPDATE payment_reports SET cycle_id = ${target.id}::uuid
            WHERE id = ${reportId}::uuid AND status = 'PENDING' AND cycle_id <> ${target.id}::uuid
            RETURNING id
          `;
          if (updated.length > 0) {
            moved += 1;
            continue;
          }

          const states = await db.$queryRaw<Array<{ status: ReportStatus; cycleId: string }>>`
            /* @pay:reassign-state */
            SELECT status, cycle_id AS "cycleId" FROM payment_reports WHERE id = ${reportId}::uuid
          `;
          const state = states[0];
          if (!state) {
            skipped.push({ reportId, reason: "not_found", message: "No se encontró el reporte." });
          } else if (state.cycleId === target.id) {
            skipped.push({ reportId, reason: "already_in_target", message: "El reporte ya está en esa semana." });
          } else {
            skipped.push({ reportId, reason: "not_pending", message: "Solo se pueden reasignar reportes pendientes." });
          }
        } catch (error) {
          // uq_report_user_cycle (D4): the person already has a live report
          // in the target week; their two reports would collide.
          if (isUniqueViolation(error)) {
            skipped.push({ reportId, reason: "duplicate_in_target", message: "La persona ya tiene un reporte en esa semana." });
            continue;
          }
          throw error;
        }
      }

      return { total: ids.length, moved, skipped, target: { id: target.id, periodKey: target.period_key } };
    },

    async listMyReports(actor, listOptions = {}) {
      const limit = clampLimit(listOptions.limit);
      return db.$queryRaw<MyReportRow[]>`
        /* @pay:my-reports */
        SELECT r.id, r.amount::text AS amount, r.currency, COALESCE(pm.label, r.method::text) AS method, r.status,
               r.paid_at AS "paidAt", r.reported_at AS "reportedAt", r.review_note AS "reviewNote",
               r.proof_key AS "proofKey", r.cycle_id AS "cycleId", c.period_key AS "periodKey"
        FROM payment_reports r
        JOIN payment_cycles c ON c.id = r.cycle_id
        LEFT JOIN payment_methods pm ON pm.id = r.method_id
        WHERE r.user_id = ${actor.id}::uuid
        ORDER BY r.reported_at DESC
        LIMIT ${limit}
      `;
    },

    async listReviewQueue(actor, listOptions = {}) {
      // The queue carries amounts and references: the guard lives HERE, not
      // only in the page that calls it (S4 — a service that trusts its callers
      // is one refactor away from a leak).
      if (actor.role !== "ROOT" && actor.role !== "ADMIN") {
        throw new ForbiddenError("Solo la administración puede revisar aportes.");
      }
      const limit = clampLimit(listOptions.limit);
      return db.$queryRaw<ReviewQueueRow[]>`
        /* @pay:review-queue */
        SELECT r.id, r.amount::text AS amount, r.currency,
               COALESCE(pm.label, r.method::text) AS method,
               r.paid_at AS "paidAt", r.reported_at AS "reportedAt", r.note, r.proof_key AS "proofKey",
               r.reference, r.user_id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
               r.cycle_id AS "cycleId", c.period_key AS "periodKey",
               COALESCE(cv.custom_values, '[]'::jsonb) AS "customValues"
        FROM payment_reports r
        JOIN users u ON u.id = r.user_id
        JOIN payment_cycles c ON c.id = r.cycle_id
        LEFT JOIN payment_methods pm ON pm.id = r.method_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
                   jsonb_build_object('label', cf.label, 'value', cfv.value)
                   ORDER BY cf.sort_order, cf.code
                 ) AS custom_values
          FROM custom_field_values cfv
          JOIN custom_fields cf ON cf.id = cfv.field_id
          WHERE cfv.entity_id = r.id
        ) cv ON true
        WHERE r.status = 'PENDING'
          AND (${listOptions.cycleId ?? null}::uuid IS NULL OR r.cycle_id = ${listOptions.cycleId ?? null}::uuid)
        ORDER BY r.reported_at ASC
        LIMIT ${limit}
      `;
    },

    async downlineOfferings(actor, listOptions) {
      // D39: while the setting is off the amount is OMITTED server-side — never masked.
      const showAmounts = await settings.getOrThrow<boolean>(SETTING_KEYS.memberSeesDownlineAmounts);
      const limit = clampLimit(listOptions.limit);
      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const condition = scope.unrestricted ? Prisma.empty : Prisma.sql`AND ${scope.fragment}`;

      const rows = await db.$queryRaw<DownlineOfferingRawRow[]>`
        /* @pay:downline-offerings */
        SELECT u.id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
               r.id AS "reportId", r.amount::text AS amount, r.currency
        FROM users u
        LEFT JOIN payment_reports r
          ON r.user_id = u.id AND r.cycle_id = ${listOptions.cycleId}::uuid AND r.status <> 'REJECTED'
        WHERE u.deleted_at IS NULL
          AND u.id <> ${actor.userId}::uuid
          ${condition}
        ORDER BY u.full_name
        LIMIT ${limit}
      `;

      return rows.map((row) => {
        const base = { userId: row.userId, fullName: row.fullName, publicCode: row.publicCode, hasOffering: row.reportId !== null };
        if (!showAmounts || row.amount === null || row.currency === null) return base;
        return { ...base, amount: formatAmount(parseAmount(row.amount)), currency: row.currency };
      });
    },
  };
}
