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

/** One page of the inbox: the rows plus the cursor for the next (older) page. */
export interface NotificationPage {
  items: NotificationItem[];
  /** Id of the last item shown; `null` when the list is exhausted. */
  nextCursor: string | null;
}

export interface NotificationsService {
  /** Unread rows for the user. Powers the SessionShell badge. */
  unreadCount(userId: string): Promise<number>;
  /** Newest first, clamped, keyset-paginated. The inbox list. */
  listForUser(
    userId: string,
    options?: { limit?: number; before?: string | null },
  ): Promise<NotificationPage>;
  /** Set `read_at` on ONE own, unread row. Returns rows affected (0 or 1). */
  markRead(userId: string, notificationId: string): Promise<number>;
  /** Set `read_at` on every own unread row. Returns rows affected. */
  markAllRead(userId: string): Promise<number>;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_NOTIFICATIONS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_NOTIFICATIONS_LIMIT);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cursor is the `id` of the last item of the previous page. It must be a
 * UUID (it is cast in SQL); anything else degrades to "first page" instead of
 * failing a 500 on a hand-edited URL.
 */
function normalizeCursor(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  return UUID_PATTERN.test(value) ? value : null;
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
      const cursor = normalizeCursor(options.before);

      // Keyset, not OFFSET: `created_at` is not unique (bulk jobs insert many
      // rows in one statement), so the tuple `(created_at, id)` is the total
      // order — the same one the ORDER BY uses. The subselect resolves the
      // cursor row at full timestamp precision (a JS Date would truncate to
      // milliseconds and could drop rows created in the same millisecond).
      // LIMIT n+1: the extra row proves there is a next page without a COUNT.
      const rows = await db.$queryRaw<NotificationItem[]>`
        /* @ntf:list */
        SELECT id, type, title, body, created_at AS "createdAt", read_at AS "readAt"
        FROM notifications
        WHERE user_id = ${userId}::uuid
          AND (
            ${cursor}::uuid IS NULL
            OR (created_at, id) < (
              SELECT created_at, id FROM notifications
              WHERE id = ${cursor}::uuid AND user_id = ${userId}::uuid
            )
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.id : null,
      };
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
