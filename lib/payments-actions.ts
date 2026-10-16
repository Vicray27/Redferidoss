// =============================================================================
// lib/payments-actions.ts — the Server Actions behind /portal/semana and
// /admin/revisiones (D29: mutations are Server Actions, not route handlers).
// Next verifies Origin/Host on every action call, which is the CSRF defence a
// cookie-authenticated mutation needs, for free.
//
// The actions do NO business work. Every rule — report window, amount mode,
// reference/proof requirements, review authority — lives in lib/payments.ts,
// and this file only maps AppError to a message a form can render and
// revalidates the affected paths. An unexpected error is rethrown so the
// framework surfaces it instead of dressing it up as a validation message.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { authorization } from "./authz";
import { prisma } from "./db";
import { AppError } from "./errors";
import {
  createPaymentsService,
  type BulkReassignSkipped,
  type BulkReviewSkipped,
  type ReviewDecision,
} from "./payments";
import { settings } from "./settings";

export interface PaymentActionResult {
  ok: boolean;
  message?: string;
  reportId?: string;
  /** First message per field from `ValidationError.details`, when present. */
  fieldErrors?: Record<string, string>;
}

/** §8.5 bulk actions: counts plus the per-item skips the UI explains (D52). */
export interface BulkPaymentActionResult {
  ok: boolean;
  message?: string;
  /** Ready-to-render summary ("3 aprobados · 1 omitido"). */
  summary?: string;
  approved?: number;
  rejected?: number;
  moved?: number;
  skipped?: Array<BulkReviewSkipped | BulkReassignSkipped>;
}

function toFailure(error: unknown): PaymentActionResult | null {
  if (error instanceof AppError) {
    // `details` from ValidationError is the field-keyed map (values may be
    // string arrays): keep the FIRST message per field, like fieldErrorsFrom().
    const details = error.details;
    let fieldErrors: Record<string, string> | undefined;
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      const entries: Array<[string, string]> = [];
      for (const [field, value] of Object.entries(details as Record<string, unknown>)) {
        const message = Array.isArray(value) ? value[0] : value;
        if (typeof message === "string") entries.push([field, message]);
      }
      if (entries.length > 0) fieldErrors = Object.fromEntries(entries);
    }
    return { ok: false, message: error.message, ...(fieldErrors ? { fieldErrors } : {}) };
  }
  return null;
}

export async function submitPaymentReportAction(input: {
  amount: string;
  methodId: string;
  reference?: string | null;
  /** `YYYY-MM-DD` from the form's date input. */
  paidAt: string;
  note?: string | null;
  /** `key` returned by POST /api/uploads (two-step flow, D29/D42). */
  proofKey?: string | null;
  /** Values keyed by custom field `code` (PAYMENT_REPORT fields, F6). */
  custom?: Record<string, unknown> | null;
}): Promise<PaymentActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const payments = createPaymentsService(prisma, settings, authorization);
    // `session.userId` is the only id ever passed in: the service resolves the
    // cycle and the ownership of the proof under the caller's own identity.
    const created = await payments.createReport(
      { id: session.userId, role: session.role },
      {
        amount: input.amount,
        methodId: input.methodId,
        reference: input.reference ?? null,
        paidAt: input.paidAt,
        note: input.note ?? null,
        proofKey: input.proofKey ?? null,
        custom: input.custom ?? null,
      },
    );

    revalidatePath("/portal/semana");
    revalidatePath("/portal");
    return { ok: true, reportId: created.id };
  } catch (error) {
    const failure = toFailure(error);
    if (failure) return failure;
    throw error;
  }
}

export async function reviewPaymentReportAction(input: {
  reportId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string | null;
}): Promise<PaymentActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const payments = createPaymentsService(prisma, settings, authorization);
    // The service re-checks that the actor is staff (ForbiddenError otherwise);
    // the action cannot grant itself authority by calling with an id.
    const reviewed = await payments.reviewReport(
      { id: session.userId, role: session.role },
      input.reportId,
      input.decision,
      input.note ?? null,
    );

    revalidatePath("/admin/revisiones");
    return { ok: true, reportId: reviewed.id };
  } catch (error) {
    const failure = toFailure(error);
    if (failure) return failure;
    throw error;
  }
}

/** "2 aprobados · 1 omitido" — one line the page can show verbatim. */
function countLabel(count: number, singular: string, plural: string): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function bulkReviewPaymentsAction(input: {
  reportIds: string[];
  decision: ReviewDecision;
  note?: string | null;
}): Promise<BulkPaymentActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const payments = createPaymentsService(prisma, settings, authorization);
    const result = await payments.reviewMany(
      { id: session.userId, role: session.role },
      input.reportIds,
      input.decision,
      input.note ?? null,
    );

    revalidatePath("/admin");
    revalidatePath("/admin/pagos");
    revalidatePath("/admin/revisiones");

    const parts = [
      countLabel(result.approved, "aprobado", "aprobados"),
      countLabel(result.rejected, "rechazado", "rechazados"),
      countLabel(result.skipped.length, "omitido", "omitidos"),
    ].filter((part): part is string => part !== null);

    return {
      ok: true,
      summary: parts.length > 0 ? parts.join(" · ") : "No había nada por hacer.",
      approved: result.approved,
      rejected: result.rejected,
      skipped: result.skipped,
    };
  } catch (error) {
    const failure = toFailure(error);
    if (failure) return failure;
    throw error;
  }
}

export async function reassignPaymentsAction(input: {
  reportIds: string[];
  targetCycleId: string;
}): Promise<BulkPaymentActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const payments = createPaymentsService(prisma, settings, authorization);
    const result = await payments.reassignReports(
      { id: session.userId, role: session.role },
      input.reportIds,
      input.targetCycleId,
    );

    revalidatePath("/admin");
    revalidatePath("/admin/pagos");
    revalidatePath("/admin/revisiones");

    const parts = [
      result.moved > 0
        ? `${result.moved} ${result.moved === 1 ? "reasignado" : "reasignados"} a ${result.target.periodKey}`
        : null,
      countLabel(result.skipped.length, "omitido", "omitidos"),
    ].filter((part): part is string => part !== null);

    return {
      ok: true,
      summary: parts.length > 0 ? parts.join(" · ") : "No había nada por hacer.",
      moved: result.moved,
      skipped: result.skipped,
    };
  } catch (error) {
    const failure = toFailure(error);
    if (failure) return failure;
    throw error;
  }
}
