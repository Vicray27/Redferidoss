// =============================================================================
// lib/notifications-actions.ts — the Server Actions behind the inbox (D59).
//
// Same doctrine as the other action files: the session never arrives from the
// client, `getSession()` is the only identity source, and the service scopes
// every statement by `user_id`. These actions are consumed by plain <form>
// posts, so the inbox works with zero client JavaScript.
//
// A missing session returns silently — the middleware and the page guards
// already turned anonymous visitors away; reaching here without a session is a
// race with an expired cookie, and there is nothing useful to write.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { prisma } from "./db";
import { createNotificationsService } from "./notifications";

function revalidateInboxes(): void {
  revalidatePath("/portal/notificaciones");
  revalidatePath("/admin/notificaciones");
}

/**
 * Mark ONE notification read. The id travels as a form field; the SQL scopes
 * the UPDATE to the session user, so an id that is not theirs changes zero
 * rows. A DB failure bubbles: that is a bug, not a user mistake.
 */
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const id = formData.get("id");
  if (typeof id !== "string" || id === "") return;

  await createNotificationsService(prisma).markRead(session.userId, id);
  revalidateInboxes();
}

/** Mark every own unread notification read, in one statement. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  await createNotificationsService(prisma).markAllRead(session.userId);
  revalidateInboxes();
}
