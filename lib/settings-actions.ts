// =============================================================================
// lib/settings-actions.ts — the Server Action behind /admin/configuracion.
//
// The form ships raw values (strings, booleans, parsed JSON); the service
// validates each one against the catalog (type, range, enum options,
// `editable_by` rank) before writing anything, so the client is trusted for
// typing only, never for authorization — `session.role` is what counts.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { prisma } from "./db";
import { AppError } from "./errors";
import { settings } from "./settings";
import { createSettingsAdminService } from "./settings-admin";

export interface SettingsActionResult {
  ok: boolean;
  message?: string;
  updated?: string[];
}

export async function updateSettingsAction(
  changes: Array<{ key: string; value: unknown }>,
): Promise<SettingsActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };
  if (changes.length === 0) {
    return { ok: false, message: "No hay cambios para guardar." };
  }

  try {
    const admin = createSettingsAdminService(prisma, {
      // The DB trigger NOTIFYs other instances; this process must drop its
      // local cache entry itself.
      invalidate: (key) => settings.invalidate(key),
    });
    const results = await admin.update({ id: session.userId, role: session.role }, changes);

    revalidatePath("/admin/configuracion");
    revalidatePath("/portal/semana");
    return { ok: true, updated: results.map((result) => result.key) };
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
