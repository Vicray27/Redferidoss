// =============================================================================
// lib/notifications.ts — §9 F7: the in-app notification inbox (D59).
//
// One row per event, addressed to ONE user. The table and its indexes were
// created in 0001_init and the only writer so far is the payment review
// (lib/payments.ts, `payment.reviewed`); this module adds the READ side and
// the badge count that SessionShell renders on every signed-in page.
//
// Ownership is enforced in SQL, not in the UI: every statement carries
// `user_id = <session user>`, so a forged id can read nothing and mark nothing
// that belongs to someone else. Marks are idempotent (`read_at IS NULL`
// guard), which is what lets the plain form posts be re-submitted harmlessly.
//
// The count rides the partial index `idx_notifications_unread` (0001_init):
// one cheap query per page render, no join, no scan of the whole history.
// =============================================================================

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface NotificationsDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export const DEFAULT_NOTIFICATIONS_LIMIT = 20;
export const MAX_NOTIFICATIONS_LIMIT = 100;

export interface NotificationsService {
  /** Unread rows for the user. Powers the SessionShell badge. */
  unreadCount(userId: string): Promise<number>;
  /** Newest first, clamped. The inbox list. */
  listForUser(userId: string, options?: { limit?: number }): Promise<NotificationItem[]>;
  /** Set `read_at` on ONE own, unread row. Returns rows affected (0 or 1). */
  markRead(userId: string, notificationId: string): Promise<number>;
  /** Set `read_at` on every own unread row. Returns rows affected. */
  markAllRead(userId: string): Promise<number>;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_NOTIFICATIONS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_NOTIFICATIONS_LIMIT);
}

export function createNotificationsService(db: NotificationsDb): NotificationsService {
  return {
    async unreadCount(userId) {
      const rows = await db.$queryRaw<Array<{ count: number }>>`
        /* @ntf:unread-count */
        SELECT COUNT(*)::int AS count
        FROM notifications
        WHERE user_id = ${userId}::uuid AND read_at IS NULL
      `;
      return rows[0]?.count ?? 0;
    },

    async listForUser(userId, options = {}) {
      const limit = clampLimit(options.limit);
      return db.$queryRaw<NotificationItem[]>`
        /* @ntf:list */
        SELECT id, type, title, body, created_at AS "createdAt", read_at AS "readAt"
        FROM notifications
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    },

    async markRead(userId, notificationId) {
      return db.$executeRaw`
        /* @ntf:mark-read */
        UPDATE notifications SET read_at = now()
        WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL
      `;
    },

    async markAllRead(userId) {
      return db.$executeRaw`
        /* @ntf:mark-all-read */
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${userId}::uuid AND read_at IS NULL
      `;
    },
  };
}
