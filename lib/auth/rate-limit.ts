// =============================================================================
// lib/auth/rate-limit.ts — fixed-window throttle for the login endpoint.
//
// Why this exists: /login is the only endpoint that accepts a password, and an
// unthrottled one turns the Argon2id hashes into an offline-speed guessing
// target. The `rate_limits` table (§5.9, fixed window keyed by
// (key, window_start)) already exists in 0001_init for this purpose.
//
// Design decisions worth stating:
//
// * FAILURES ARE COUNTED, NOT ATTEMPTS. Counting every request would let an
//   attacker lock a legitimate user out with a handful of junk POSTs — a
//   denial of service against a known address. Counting failures throttles the
//   guessing itself, which is the actual attack. A user who mistypes three
//   times has not reached the limit.
//
// * THE KEY IS A HASH OF THE EMAIL. The address is a CITEXT value the user
//   chose; storing it in a table that nothing displays would be collecting PII
//   for no benefit. The window bucket needs a stable, non-reversible label.
//
// * FIXED WINDOW, not sliding. §5.9 defines a composite (key, window_start)
//   primary key, which is a fixed window by construction. A sliding window
//   would need a different table shape and a migration; the only cost is that a
//   determined attacker gets two bursts across a boundary, which is acceptable
//   at this limit.
//
// Dependencies are injected so tests can count rows, the clock and the hash
// without a database, exactly like lib/settings.ts and lib/auth/login.ts.
// =============================================================================

import { createHash } from "node:crypto";

/** Window length. Long enough not to punish typos, short to limit guessing. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Failed attempts allowed per window before the login is refused. */
export const LOGIN_MAX_FAILURES = 8;

/** Minimal raw-query client, same structural type as lib/users.ts. */
export type RawQueryDb = {
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

export interface RateLimiter {
  /** Current failure count for the window containing `now`. Never negative. */
  current(email: string, now?: number): Promise<number>;
  /** Record one failed attempt. Returns the new count. */
  recordFailure(email: string, now?: number): Promise<number>;
  /** Clear the counter after a successful login. */
  reset(email: string, now?: number): Promise<void>;
  /** Stable, non-reversible storage key for an address. */
  keyFor(email: string): string;
}

/** SHA-256 of the normalised address, hex. Not reversible, and fixed length. */
export function loginRateLimitKey(email: string): string {
  const digest = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  return `login:${digest.slice(0, 32)}`;
}

/** Start of the fixed window containing `now`. */
export function windowStart(now: number, windowMs = LOGIN_WINDOW_MS): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

export function createLoginRateLimiter(
  db: RawQueryDb,
  options: { now?: () => number; windowMs?: number } = {},
): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;

  const keyFor = (email: string) => loginRateLimitKey(email);

  return {
    keyFor,

    async current(email: string): Promise<number> {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count FROM rate_limits
        WHERE key = ${keyFor(email)} AND window_start = ${windowStart(now(), windowMs)}
      `;
      const value = rows[0]?.count;
      return value === undefined ? 0 : Number(value);
    },

    async recordFailure(email: string): Promise<number> {
      // Atomic upsert: two concurrent wrong-password submissions must not both
      // read 7 and both store 7, which would let a burst slip past the limit.
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`
        INSERT INTO rate_limits (key, window_start, count)
        VALUES (${keyFor(email)}, ${windowStart(now(), windowMs)}, 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
        RETURNING count
      `;
      const value = rows[0]?.count;
      return value === undefined ? 0 : Number(value);
    },

    async reset(email: string): Promise<void> {
      // Deletes this window's row only. Removing older windows is the job of a
      // cleanup job (F7); leaving them costs one row per attempt per 15 min.
      await db.$queryRaw`
        DELETE FROM rate_limits
        WHERE key = ${keyFor(email)} AND window_start = ${windowStart(now(), windowMs)}
      `;
    },
  };
}

/**
 * The message shown once the limit is reached.
 *
 * Says nothing about whether the account exists, for the same reason
 * INVALID_CREDENTIALS_MESSAGE says nothing: the throttle must not become an
 * enumeration oracle.
 */
export const RATE_LIMITED_MESSAGE =
  "Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.";