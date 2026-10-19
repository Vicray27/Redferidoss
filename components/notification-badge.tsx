// =============================================================================
// components/notification-badge.tsx — the unread count in the session header.
//
// Rendered inside SessionShell on every signed-in page, so it stays ONE round
// trip: the count comes from the partial index `idx_notifications_unread`
// (0001_init) and nothing else is queried.
//
// The inbox LINK depends on the role, exactly like the rest of the shell:
// staff live under /admin, members under /portal. That is navigation, not
// authorization — both inbox pages guard themselves.
// =============================================================================

import Link from "next/link";
import { Bell } from "lucide-react";

import { isStaffRole } from "@/lib/auth/guards";
import type { SessionPayload } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createNotificationsService } from "@/lib/notifications";

export async function NotificationBadge({ session }: { session: SessionPayload }) {
  const unread = await createNotificationsService(prisma).unreadCount(session.userId);
  const href = isStaffRole(session.role) ? "/admin/notificaciones" : "/portal/notificaciones";

  return (
    <Link
      href={href}
      className="relative inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted sm:h-auto sm:px-3 sm:py-2"
      aria-label={unread > 0 ? `Notificaciones: ${unread} sin leer` : "Notificaciones"}
    >
      <Bell className="h-4 w-4 sm:hidden" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">Notificaciones</span>
      {unread > 0 ? (
        <span className="absolute -right-2 -top-2 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-5 text-primary-foreground">
          {unread}
        </span>
      ) : null}
    </Link>
  );
}
