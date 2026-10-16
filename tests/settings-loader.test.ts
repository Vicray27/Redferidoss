// =============================================================================
// tests/settings-loader.test.ts — the DATABASE half of lib/settings.ts (WU4).
//
// tests/settings.test.ts covers `createSettingsReader` over fake loaders (the
// cache/TTL/invalidation contract). This file covers what that one cannot:
//   * `prismaSettingsLoader`, the real loader wired to Prisma,
//   * the process-wide `settings` reader and its convenience wrappers,
//   * `startSettingsNotifyListener`, the LISTEN/NOTIFY half of acceptance A1
//     ("change the setting and it applies immediately"), with `pg` mocked.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queryRaw: vi.fn() }));
const pgState = vi.hoisted(() => ({ clients: [] as FakePgClient[] }));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: db.queryRaw } }));

interface FakePgClient {
  options: unknown;
  handlers: Map<string, (message: { payload?: string; message?: string }) => void>;
  queries: string[];
  connected: boolean;
  ended: boolean;
  emit(event: string, message: { payload?: string; message?: string }): void;
  end(): Promise<void>;
}

vi.mock("pg", () => ({
  Client: class implements FakePgClient {
    options: unknown;
    handlers = new Map<string, (message: { payload?: string; message?: string }) => void>();
    queries: string[] = [];
    connected = false;
    ended = false;

    constructor(options: unknown) {
      this.options = options;
      pgState.clients.push(this);
    }

    on(event: string, handler: (message: { payload?: string; message?: string }) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    async connect(): Promise<void> {
      this.connected = true;
    }

    async query(text: string): Promise<unknown> {
      this.queries.push(text);
      return {};
    }

    async end(): Promise<void> {
      this.ended = true;
    }

    emit(event: string, message: { payload?: string; message?: string }): void {
      this.handlers.get(event)?.(message);
    }
  },
}));

import { SETTINGS_CATALOG_BY_KEY } from "../lib/settings-catalog";
import {
  getSetting,
  getSettingOrThrow,
  knownSettingKeys,
  notifySettingsChanged,
  prismaSettingsLoader,
  settings,
  SETTINGS_NOTIFY_CHANNEL,
  SettingsMissingError,
  startSettingsNotifyListener,
} from "../lib/settings";

function lastClient(): FakePgClient {
  return pgState.clients[pgState.clients.length - 1]!;
}

beforeEach(() => {
  db.queryRaw.mockReset();
  pgState.clients.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prismaSettingsLoader", () => {
  it("maps the first row to a SettingsRow", async () => {
    const row = { key: "payments.currency", value: "USD", type: "STRING" };
    db.queryRaw.mockResolvedValueOnce([row]);

    await expect(prismaSettingsLoader("payments.currency")).resolves.toBe(row);

    const [strings, ...values] = db.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("FROM settings WHERE key =");
    expect(values).toEqual(["payments.currency"]);
  });

  it("returns null when the key is absent (never a default value)", async () => {
    db.queryRaw.mockResolvedValueOnce([]);

    await expect(prismaSettingsLoader("nope")).resolves.toBeNull();
  });
});

describe("process-wide settings reader", () => {
  it("getSetting serves the first read from the loader and caches it for 60 s", async () => {
    db.queryRaw.mockResolvedValue([
      { key: "test.wu4.cache", value: 7, type: "INT" },
    ]);

    await expect(getSetting<number>("test.wu4.cache")).resolves.toBe(7);
    await expect(getSetting<number>("test.wu4.cache")).resolves.toBe(7);
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
    expect(settings.size()).toBeGreaterThanOrEqual(1);
  });

  it("notifySettingsChanged drops the local cache entry (A1: applies immediately)", async () => {
    db.queryRaw.mockResolvedValueOnce([
      { key: "test.wu4.notify", value: "v1", type: "STRING" },
    ]);
    await expect(getSetting("test.wu4.notify")).resolves.toBe("v1");

    notifySettingsChanged("test.wu4.notify");

    db.queryRaw.mockResolvedValueOnce([
      { key: "test.wu4.notify", value: "v2", type: "STRING" },
    ]);
    await expect(getSetting("test.wu4.notify")).resolves.toBe("v2");
    expect(db.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("getSetting returns null for an absent key instead of a silent default", async () => {
    db.queryRaw.mockResolvedValueOnce([]);

    await expect(getSetting("test.wu4.absent")).resolves.toBeNull();
  });

  it("getSettingOrThrow throws SettingsMissingError naming the key", async () => {
    db.queryRaw.mockResolvedValue([]);

    await expect(getSettingOrThrow("test.wu4.missing")).rejects.toThrow(SettingsMissingError);
    await expect(getSettingOrThrow("test.wu4.missing")).rejects.toThrow(/test\.wu4\.missing/);
  });
});

describe("knownSettingKeys", () => {
  it("returns exactly the catalog keys, for diagnostics and /admin/settings", () => {
    const keys = knownSettingKeys();
    expect(keys.length).toBe(SETTINGS_CATALOG_BY_KEY.size);
    expect(keys).toContain("payments.currency");
    expect(keys).toContain("security.login_rate_limit_per_15m");
  });
});

describe("startSettingsNotifyListener", () => {
  it("without DATABASE_URL it warns and returns a no-op stop (TTL-only fallback)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = await startSettingsNotifyListener("");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
    expect(pgState.clients).toHaveLength(0);
    await expect(stop()).resolves.toBeUndefined();
  });

  it("connects, LISTENs on the migration's channel and forwards payloads", async () => {
    const url = "postgres://user:pass@localhost:5432/referidos";
    const onInvalidate = vi.fn();

    const stop = await startSettingsNotifyListener(url, onInvalidate);
    const client = lastClient();

    expect(client.options).toEqual({ connectionString: url });
    expect(client.connected).toBe(true);
    expect(client.queries).toContain(`LISTEN ${SETTINGS_NOTIFY_CHANNEL}`);

    client.emit("notification", { payload: "payments.currency" });
    expect(onInvalidate).toHaveBeenLastCalledWith("payments.currency");

    // Empty payload means "invalidate everything" -> undefined key.
    client.emit("notification", { payload: "" });
    expect(onInvalidate).toHaveBeenLastCalledWith(undefined);
    expect(onInvalidate).toHaveBeenCalledTimes(2);

    await stop();
    expect(client.ended).toBe(true);
  });

  it("logs listener errors instead of taking the process down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await startSettingsNotifyListener("postgres://localhost/x", vi.fn());
    const client = lastClient();

    client.emit("error", { message: "connection reset" });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("NOTIFY listener error"),
      "connection reset",
    );

    await client.end();
  });
});
