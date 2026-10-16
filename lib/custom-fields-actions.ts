// =============================================================================
// lib/custom-fields-actions.ts — the Server Actions behind
// /admin/campos-personalizados.
//
// Same doctrine as lib/payment-methods-actions.ts: the form ships raw values,
// the service validates and authorizes (`session.role` is what counts), and the
// session never arrives from the client. AppErrors become the action's result;
// anything else keeps bubbling up, because it is a bug and must be visible.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { prisma } from "./db";
import { AppError } from "./errors";
import {
  createCustomFieldsAdminService,
  type CustomFieldUpdate,
  type NewCustomField,
} from "./custom-fields-admin";

export interface CustomFieldActionResult {
  ok: boolean;
  message?: string;
  /** Field-keyed messages from `ValidationError.details`, when present. */
  fieldErrors?: Record<string, string>;
}

function toFailure(error: unknown): CustomFieldActionResult {
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

/** Every surface that renders a form built from these definitions. */
function revalidateDefinitionSurfaces(): void {
  revalidatePath("/admin/campos-personalizados");
  revalidatePath("/admin");
  revalidatePath("/r/[code]", "page");
  revalidatePath("/invite/[token]", "page");
  revalidatePath("/portal/semana");
}

export async function createCustomFieldAction(
  input: NewCustomField,
): Promise<CustomFieldActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    await createCustomFieldsAdminService(prisma).create(
      { id: session.userId, role: session.role },
      input,
    );
    revalidateDefinitionSurfaces();
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function updateCustomFieldAction(
  id: string,
  input: CustomFieldUpdate,
): Promise<CustomFieldActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    await createCustomFieldsAdminService(prisma).update(
      { id: session.userId, role: session.role },
      id,
      input,
    );
    revalidateDefinitionSurfaces();
    return { ok: true };
  } catch (error) {
    return toFailure(error);
  }
}

export async function moveCustomFieldAction(
  id: string,
  direction: "up" | "down",
): Promise<CustomFieldActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const result = await createCustomFieldsAdminService(prisma).move(
      { id: session.userId, role: session.role },
      id,
      direction,
    );
    revalidateDefinitionSurfaces();
    return {
      ok: true,
      message: result.moved ? undefined : "El campo ya está en el extremo de su lista.",
    };
  } catch (error) {
    return toFailure(error);
  }
}
