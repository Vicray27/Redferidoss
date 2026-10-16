// =============================================================================
// app/portal/notificaciones/page.tsx — the member inbox (D59).
//
// `requireSession`, not `requireStaffSession`: every authenticated role may
// open it (staff can read /portal too). Reads are direct service calls; the
// service scopes by `user_id`, so the page never chooses whose rows it sees.
// =============================================================================

import { NotificationsInbox } from "@/components/notifications-inbox";
import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { createNotificationsService } from "@/lib/notifications";

// The unread badge is one click stale on a cached page: never cache this one.
export const dynamic = "force-dynamic";

export default async function PortalNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ antes?: string }>;
}) {
  const session = await requireSession("/portal/notificaciones");
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
      description="Los avisos de tu semana y de tus aportes, en un solo lugar."
    >
      <NotificationsInbox
        items={page.items}
        unreadCount={unreadCount}
        olderHref={page.nextCursor ? `?antes=${page.nextCursor}` : null}
      />
    </SessionShell>
  );
}
