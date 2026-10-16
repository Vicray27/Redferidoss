// =============================================================================
// tests/notifications.test.ts — §9 F7 inbox service (D59).
//
// The fake routes by the `/* @ntf:… */` marker (same convention as PayFake),
// so these tests assert the actual SQL values and the ownership predicates:
// every statement carries `user_id`, and marking is idempotent (`read_at IS
// NULL`), which is what makes the plain form posts in the UI safe to repeat.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATIONS_LIMIT,
  MAX_NOTIFICATIONS_LIMIT,
  createNotificationsService,
  type NotificationsDb,
} from "../lib/notifications";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T12:00:00.000Z");

type Handler = (values: unknown[]) => unknown;

class NtfFake implements NotificationsDb {
  readonly queries: Array<{ marker: string; text: string; values: unknown[] }> = [];
  readonly executions: Array<{ marker: string; text: string; values: unknown[] }> = [];
  private readonly queryHandlers = new Map<string, Handler>();
  private readonly execHandlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.queryHandlers.set(marker, handler);
    return this;
  }

  onExec(marker: string, handler: Handler): this {
    this.execHandlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; text: string; values: unknown[] }> {
    return this.queries.filter((call) => call.marker === marker);
  }

  execCallsFor(marker: string): Array<{ marker: string; text: string; values: unknown[] }> {
    return this.executions.filter((call) => call.marker === marker);
  }

  valuesOf(marker: string): unknown[] {
    return this.callsFor(marker)[0]?.values ?? [];
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @ntf:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`NtfFake: unmarked statement: ${text}`);
    const handler = this.queryHandlers.get(marker);
    if (!handler) throw new Error(`NtfFake: no handler for ${marker}`);
    this.queries.push({ marker, text, values });
    return (await handler(values)) as T;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = strings.join("?");
    const marker = /\/\* @ntf:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`NtfFake: unmarked statement: ${text}`);
    this.executions.push({ marker, text, values });
    const handler = this.execHandlers.get(marker);
    return handler ? (handler(values) as number) : 1;
  }
}

const ITEM = {
  id: "ntf-1",
  type: "payment.reviewed",
  title: "Aporte aprobado",
  body: "Tu aporte de la semana fue aprobado.",
  createdAt: NOW,
  readAt: null,
};

function build() {
  const db = new NtfFake();
  db.on("unread-count", () => [{ count: 3 }])
    .on("list", () => [ITEM]);
  const service = createNotificationsService(db);
  return { db, service };
}

describe("unreadCount", () => {
  it("counts only the user's unread rows, cast to int", async () => {
    const { db, service } = build();

    await expect(service.unreadCount(USER)).resolves.toBe(3);

    const call = db.callsFor("unread-count")[0]!;
    expect(call.values).toEqual([USER]);
    expect(call.text).toContain("COUNT(*)::int");
    expect(call.text).toContain("read_at IS NULL");
  });

  it("returns 0 when the row is missing", async () => {
    const { db, service } = build();
    db.on("unread-count", () => []);

    await expect(service.unreadCount(USER)).resolves.toBe(0);
  });
});

describe("listForUser", () => {
  it("lists newest-first with the default limit and the ownership predicate", async () => {
    const { db, service } = build();

    await expect(service.listForUser(USER)).resolves.toEqual([ITEM]);

    const call = db.callsFor("list")[0]!;
    expect(call.values).toEqual([USER, DEFAULT_NOTIFICATIONS_LIMIT]);
    expect(call.text).toContain("ORDER BY created_at DESC");
    expect(call.text).toContain("user_id =");
  });

  it("clamps the limit to [1, MAX]", async () => {
    const { db, service } = build();

    await service.listForUser(USER, { limit: 500 });
    await service.listForUser(USER, { limit: 0 });
    await service.listForUser(USER, { limit: Number.NaN });

    expect(db.callsFor("list").map((call) => call.values[1])).toEqual([
      MAX_NOTIFICATIONS_LIMIT,
      1,
      DEFAULT_NOTIFICATIONS_LIMIT,
    ]);
  });
});

describe("markRead", () => {
  it("scopes the UPDATE to the user and only unread rows, returning rows affected", async () => {
    const { db, service } = build();
    db.onExec("mark-read", () => 1);

    await expect(service.markRead(USER, "ntf-1")).resolves.toBe(1);

    const call = db.execCallsFor("mark-read")[0]!;
    expect(call.values).toEqual(["ntf-1", USER]);
    expect(call.text).toContain("SET read_at = now()");
    expect(call.text).toContain("AND user_id =");
    expect(call.text).toContain("read_at IS NULL");
  });

  it("returns 0 when the row is someone else's or already read", async () => {
    const { db, service } = build();
    db.onExec("mark-read", () => 0);

    await expect(service.markRead(USER, "ntf-9")).resolves.toBe(0);
  });
});

describe("markAllRead", () => {
  it("clears every unread row of the user in one statement", async () => {
    const { db, service } = build();
    db.onExec("mark-all-read", () => 4);

    await expect(service.markAllRead(USER)).resolves.toBe(4);

    const call = db.execCallsFor("mark-all-read")[0]!;
    expect(call.values).toEqual([USER]);
    expect(call.text).toContain("UPDATE notifications");
    expect(call.text).toContain("read_at IS NULL");
  });
});
