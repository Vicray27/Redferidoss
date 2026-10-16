// =============================================================================
// lib/payment-methods-actions.ts — the Server Actions behind /admin/metodos-pago.
//
// Same doctrine as lib/settings-actions.ts: the form ships raw values, the
// service validates and authorizes (`session.role` is what counts), and the
// session never arrives from the client. AppErrors become the action's result;
// anything else keeps bubbling up, because it is a bug and must be visible.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { prisma } from "./db";
import { AppError } from "./errors";
import {
  createPaymentMethodsAdminService,
  type NewPaymentMethod,
  type PaymentMethodUpdate,
} from "./payment-methods-admin";

export interface PaymentMethodActionResult {
  ok: boolean;
  message?: string;
  /** Field-keyed messages from `ValidationError.details`, when present. */
  fieldErrors?: Record<string, string>;
}

function toFailure(error: unknown): PaymentMethodActionResult {
  if (error instanceof AppError) {
    const details = error.details;
    const fieldErrors =
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, string>)
        : undefined;
    return { ok: false, message: error.message, ...(fieldErrors ? { fieldErrors } : {}) };
  }
  throw error;
}

/** Revalidate every surface that renders the catalog or its labels. */
function revalidateCatalog(): void {
  revalidatePath("/admin/metodos-pago");
  revalidatePath("/admin");
  revalidatePath("/portal/semana");
}

export async function createPaymentMethodAction(
  input: NewPaymentMethod,
): Promise<PaymentMethodActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    await createPaymentMethodsAdminService(prisma).create(
      { id: session.userId, role: session.role },
      input,
    );
    revalidateCatalog();
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function updatePaymentMethodAction(
  id: string,
  input: PaymentMethodUpdate,
): Promise<PaymentMethodActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    await createPaymentMethodsAdminService(prisma).update(
      { id: session.userId, role: session.role },
      id,
      input,
    );
    revalidateCatalog();
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function movePaymentMethodAction(
  id: string,
  direction: "up" | "down",
): Promise<PaymentMethodActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const result = await createPaymentMethodsAdminService(prisma).move(
      { id: session.userId, role: session.role },
      id,
      direction,
    );
    revalidateCatalog();
    return { ok: true, message: result.moved ? undefined : "El método ya está en el extremo de la lista." };
  } catch (error) {
    return toFailure(error);
  }
}
