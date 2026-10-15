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
import { prisma } from "./db";
import { AppError } from "./errors";
import { createPaymentsService } from "./payments";
import { settings } from "./settings";

export interface PaymentActionResult {
  ok: boolean;
  message?: string;
  reportId?: string;
}

function toFailure(error: unknown): PaymentActionResult | null {
  if (error instanceof AppError) {
    return { ok: false, message: error.message };
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
}): Promise<PaymentActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const payments = createPaymentsService(prisma, settings);
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
    const payments = createPaymentsService(prisma, settings);
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
