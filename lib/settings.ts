// =============================================================================
// lib/settings.ts — settings-as-truth accessor (§6, §18.3-4).
//
// Rule the whole project obeys: business parameters are NEVER hardcoded. They
// live in the `settings` table, are cached in memory for 60 s, and are
// invalidated across every instance through Postgres LISTEN/NOTIFY so a change
// takes effect without a restart (acceptance A1: change
// `referral.max_direct_referrals` from 12 to 10 and it must apply immediately).
//
// There is exactly one silent-default-free contract here:
//   * getSetting(key)      -> Promise<T | null>  — null means "absent", and the
//                              return type forces the caller to handle it. It
//                              never substitutes a fallback value.
//   * getSettingOrThrow()  -> Promise<T>         — throws SettingsMissingError
//                              naming the key. Use this for every parameter the
//                              code depends on; a mis-seeded database must fail
//                              loudly at the first call, not produce plausible
//                              numbers.
// (D9 in docs/decisiones.md records why both exist.)
//
// The reader is built by `createSettingsReader(loader, …)` so tests can inject
// a fake loader and exercise cache/TTL/invalidation with no database. The
// module-level `settings` reader is the one wired to Prisma at import time.
// =============================================================================

import { Client as PgClient } from "pg";

import { prisma } from "./db";
import { SETTINGS_CATALOG_BY_KEY } from "./settings-catalog";

/** §6: "caché en memoria de 60 s". */
export const SETTINGS_CACHE_TTL_MS = 60_000;

/** §6: NOTIFY channel name, emitted by migration 0002_settings_notify. */
export const SETTINGS_NOTIFY_CHANNEL = "settings_changed";

/** Thrown when a key that the code depends on is absent from the database. */
export class SettingsMissingError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `SETTINGS_MISSING: the setting "${key}" does not exist. ` +
        `Run "pnpm seed:root" to insert the §6 catalog, or add the key deliberately. ` +
        `There is no default on purpose: business parameters are never hardcoded.`,
    );
    this.name = "SettingsMissingError";
    this.key = key;
  }
}

export interface SettingsRow {
  key: string;
  value: unknown;
  type: string;
}

/** Fetches one row, or null when the key is absent. Implemented over Prisma. */
export type SettingsLoader = (key: string) => Promise<SettingsRow | null>;

export interface SettingsReader {
  /** Cached read. Resolves null when the key is absent — never a default. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Same read, but an absent key throws `SettingsMissingError`. */
  getOrThrow<T = unknown>(key: string): Promise<T>;
  /** Drop one key from the cache (NOTIFY handler) or all of it when omitted. */
  invalidate(key?: string): void;
  /** Cache-only read: undefined when absent or expired. Never hits the DB. */
  peek<T = unknown>(key: string): T | undefined;
  /** Number of live cache entries. Diagnostics and tests. */
  size(): number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface SettingsReaderOptions {
  ttlMs?: number;
  /** Injectable clock so TTL expiry is testable without waiting a minute. */
  now?: () => number;
}

/**
 * Build a reader over an arbitrary loader.
 *
 * Only PRESENT values are cached. A missing key is not negative-cached on
 * purpose: a key inserted later (for example by /admin/settings) must be
 * visible on the very next read instead of after the TTL.
 */
export function createSettingsReader(
  loader: SettingsLoader,
  options: SettingsReaderOptions = {},
): SettingsReader {
  const ttlMs = options.ttlMs ?? SETTINGS_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  const invalidate = (key?: string): void => {
    if (key === undefined) cache.clear();
    else cache.delete(key);
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.value as T;

      const row = await loader(key);
      if (!row) {
        // Expired/absent entries must not shadow a later write.
        cache.delete(key);
        return null;
      }
      cache.set(key, { value: row.value, expiresAt: now() + ttlMs });
      return row.value as T;
    },

    async getOrThrow<T>(key: string): Promise<T> {
      const value = await this.get<T>(key);
      if (value === null) throw new SettingsMissingError(key);
      return value;
    },

    invalidate,

    peek<T>(key: string): T | undefined {
      const cached = cache.get(key);
      if (!cached || cached.expiresAt <= now()) return undefined;
      return cached.value as T;
    },

    size: () => cache.size,
  };
}

/** Default loader: one indexed primary-key lookup per cache miss. */
export const prismaSettingsLoader: SettingsLoader = async (key) => {
  const rows = await prisma.$queryRaw<SettingsRow[]>`
    SELECT key, value, type FROM settings WHERE key = ${key}
  `;
  return rows[0] ?? null;
};

/** Process-wide reader used by application code. */
export const settings: SettingsReader = createSettingsReader(prismaSettingsLoader);

/**
 * Convenience wrapper around the process-wide reader, for the common
 * "this parameter must exist" case. Prefer `settings` when you need to
 * invalidate or inspect the cache.
 */
export function getSetting<T = unknown>(key: string): Promise<T | null> {
  return settings.get<T>(key);
}

export function getSettingOrThrow<T = unknown>(key: string): Promise<T> {
  return settings.getOrThrow<T>(key);
}

/** Local half of the NOTIFY contract: drop the cached copy of `key`. */
export function notifySettingsChanged(key?: string): void {
  settings.invalidate(key);
}

/**
 * Listens for `settings_changed` and invalidates this process's cache.
 *
 * `pg` owns a dedicated connection here on purpose: LISTEN is session state
 * and must survive while the pooled Prisma connection is idle. Migration
 * 0002_settings_notify raises the notification from a trigger on `settings`,
 * so ANY writer (app, psql, admin panel) invalidates every instance.
 *
 * Returns a stop function. Never resolves the process: a listener failure must
 * not take the app down, it only means instances fall back to the 60 s TTL.
 */
export async function startSettingsNotifyListener(
  databaseUrl: string = process.env.DATABASE_URL ?? "",
  onInvalidate: (key?: string) => void = notifySettingsChanged,
): Promise<() => Promise<void>> {
  if (!databaseUrl) {
    console.warn("[settings] DATABASE_URL is not set: NOTIFY listener disabled, relying on the 60s TTL.");
    return async () => {};
  }

  const client = new PgClient({ connectionString: databaseUrl });
  client.on("notification", (message) => {
    // Payload is the key; an empty payload means "invalidate everything".
    const key = message.payload && message.payload.length > 0 ? message.payload : undefined;
    onInvalidate(key);
  });
  client.on("error", (error) => {
    console.error("[settings] NOTIFY listener error, falling back to the 60s TTL:", error.message);
  });

  await client.connect();
  await client.query(`LISTEN ${SETTINGS_NOTIFY_CHANNEL}`);

  return async () => {
    await client.end().catch(() => {});
  };
}

/** Keys the catalog defines, for diagnostics and the /admin/settings screen. */
export function knownSettingKeys(): string[] {
  return [...SETTINGS_CATALOG_BY_KEY.keys()];
}