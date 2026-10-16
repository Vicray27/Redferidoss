// =============================================================================
// app/admin/notificaciones/page.tsx — the staff inbox (D59).
//
// Staff live under /admin, so their inbox does too; the shell's badge links
// here for ROOT/ADMIN. Same service and same SQL scoping as the member inbox —
// only the frame and the copy differ.
// =============================================================================

import { NotificationsInbox } from "@/components/notifications-inbox";
import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { createNotificationsService } from "@/lib/notifications";

// The unread badge is one click stale on a cached page: never cache this one.
export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ antes?: string }>;
}) {
  const session = await requireStaffSession("/admin/notificaciones");
  const { antes } = await searchParams;

  const notifications = createNotificationsService(prisma);
  const [page, unreadCount] = await Promise.all([
    notifications.listForUser(session.userId, { before: antes ?? null }),
    notifications.unreadCount(session.userId),
  ]);

  return (
    <SessionShell
      session={session}
      title="Notificaciones"
      description="Los avisos del sistema: revisión de aportes y novedades de la red."
    >
      <NotificationsInbox
        items={page.items}
        unreadCount={unreadCount}
        olderHref={page.nextCursor ? `?antes=${page.nextCursor}` : null}
      />
    </SessionShell>
  );
}
