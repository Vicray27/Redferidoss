// =============================================================================
// components/notifications-inbox.tsx — the shared inbox body for
// /portal/notificaciones and /admin/notificaciones (D59).
//
// Server-rendered on purpose: marking read is a plain form POST to a Server
// Action, so the list works with zero client JavaScript and no per-user state
// lives in the markup — the SQL scoping in lib/notifications.ts is the only
// authority. Dates are formatted on the server (dateLabel) so SSR and any
// later hydration render identical text.
// =============================================================================

import { Button } from "@/components/ui/button";
import type { NotificationItem } from "@/lib/notifications";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/notifications-actions";
import { dateLabel } from "@/lib/reports";
import { cn } from "@/lib/utils";

export function NotificationsInbox({
  items,
  unreadCount,
  olderHref = null,
}: {
  items: NotificationItem[];
  unreadCount: number;
  /** Keyset "older page" link (`?antes=<id>`); null when the list is exhausted. */
  olderHref?: string | null;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border bg-background p-6 text-sm text-muted-foreground">
        No tienes notificaciones por ahora. Aquí llegarán los avisos del sistema.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {unreadCount > 0 ? (
        <form action={markAllNotificationsReadAction} className="flex justify-end">
          <Button type="submit" variant="outline" className="h-8 px-3 text-xs">
            Marcar todas como leídas ({unreadCount})
          </Button>
        </form>
      ) : null}

      <ul className="space-y-3">
        {items.map((item) => {
          const unread = item.readAt === null;
          return (
            <li
              key={item.id}
              className={cn(
                "rounded-lg border bg-background p-4",
                unread && "border-l-4 border-l-primary",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className={cn("text-sm", unread ? "font-semibold" : "font-medium text-muted-foreground")}>
                    {item.title}
                  </p>
                  {item.body ? <p className="text-sm text-muted-foreground">{item.body}</p> : null}
                  <p className="text-xs text-muted-foreground">
                    Publicado el {dateLabel(item.createdAt)}
                    {unread ? " · Sin leer" : ""}
                  </p>
                </div>

                {unread ? (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button
                      type="submit"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      aria-label={`Marcar como leída: ${item.title}`}
                    >
                      Marcar leída
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {olderHref ? (
        <div className="flex justify-center">
          <a href={olderHref} className="text-sm underline underline-offset-4">
            Ver más antiguas
          </a>
        </div>
      ) : null}
    </div>
  );
}
