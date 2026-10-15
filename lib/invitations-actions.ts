// =============================================================================
// lib/invitations-actions.ts — the Server Actions behind /portal/invitations.
//
// Server Actions, not route handlers, for the same reason as login
// (lib/auth/actions.ts): Next verifies Origin/Host on every action call, which
// is the CSRF defence a cookie-authenticated mutation needs. The public
// register endpoint had to hand-roll it because its callers have no session;
// here the framework check is free.
//
// Authorization is the same as any other invitation read/write: the service
// re-checks the quota under the caller's own id, so an action cannot create an
// invitation on behalf of somebody else — `session.userId` is the only id that
// is ever passed in.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { prisma } from "./db";
import { InviteInvalidError, ReferralLimitError, createInvitationsService } from "./invitations";
import { settings } from "./settings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InvitationActionResult {
  ok: boolean;
  message?: string;
  /** Same-origin path (`/invite/<token>`); the client absolutizes it. */
  link?: string;
  invitationId?: string;
}

export async function createInvitationAction(input: {
  emailTarget?: string;
  expiresInHours?: number | null;
}): Promise<InvitationActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  const emailTarget = input.emailTarget?.trim() ?? "";
  if (emailTarget !== "" && !EMAIL_RE.test(emailTarget)) {
    return { ok: false, message: "Ingresa un correo válido o deja el campo vacío." };
  }

  let expiresInHours: number | null = null;
  if (input.expiresInHours !== undefined && input.expiresInHours !== null) {
    const value = Number(input.expiresInHours);
    if (!Number.isInteger(value) || value < 0 || value > 24 * 365) {
      return { ok: false, message: "La vigencia debe ser un número de horas entre 0 y 8760." };
    }
    expiresInHours = value;
  }

  try {
    const invitations = createInvitationsService(prisma, settings);
    const created = await invitations.createSingleUse(session.userId, {
      emailTarget: emailTarget === "" ? null : emailTarget,
      expiresInHours,
    });

    revalidatePath("/portal/invitations");

    return { ok: true, link: `/invite/${created.token}`, invitationId: created.id };
  } catch (error) {
    if (error instanceof ReferralLimitError) {
      return { ok: false, message: error.message };
    }
    // Anything else is a real fault; let the framework surface it instead of
    // dressing it up as a validation message.
    throw error;
  }
}

export async function revokeInvitationAction(
  invitationId: string,
): Promise<InvitationActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const invitations = createInvitationsService(prisma, settings);
    // `revoke` only touches rows owned by the caller (WHERE user_id = ...).
    const revoked = await invitations.revoke(session.userId, invitationId);
    if (!revoked) {
      return { ok: false, message: "Esa invitación ya no existe o ya no te pertenece." };
    }

    revalidatePath("/portal/invitations");
    return { ok: true };
  } catch (error) {
    if (error instanceof InviteInvalidError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
