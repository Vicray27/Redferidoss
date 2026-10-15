// =============================================================================
// lib/throttle.ts — a small fixed-window throttle for the public endpoints.
//
// WHY IN MEMORY, AND WHY THAT IS ENOUGH HERE
// ------------------------------------------
// §13.3 asks for rate limiting on login and registration. Login already has a
// persistent, failure-counting limiter (lib/auth/rate-limit.ts) because its
// window must survive restarts: an attacker's progress must not reset with a
// deploy. The public registration path needs a different thing — a blunt cap
// on requests per IP per window — and this deployment is a single container
// (Docker Compose), so a process-local window is honest about its own scope.
// If the app is ever scaled horizontally this module must move behind a
// shared store; the interface here is deliberately tiny to make that swap a
// single-file change.
//
// Fixed windows, not sliding: one integer per key, no per-hit timestamps to
// keep. The boundary effect (a burst that straddles two windows) is a real
// property of fixed windows and acceptable for this purpose; the login
// limiter, where precision matters more, already solves it differently.
// =============================================================================

import { AppError } from "./errors";

export const TOO_MANY_REQUESTS_MESSAGE =
  "Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.";

/** 429 with the §10 envelope. */
export class RateLimitedError extends AppError {
  constructor() {
    super(429, "RATE_LIMITED", TOO_MANY_REQUESTS_MESSAGE);
    this.name = "RateLimitedError";
  }
}

export interface ThrottleOptions {
  windowMs: number;
  /** Requests allowed per key per window. */
  max: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Above this many live keys, stale ones are pruned on write. */
  maxKeys?: number;
}

export interface ThrottleVerdict {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface Throttle {
  /** Count one attempt for `key` and say whether it may proceed. */
  attempt(key: string): ThrottleVerdict;
  /** Live key count; diagnostics and tests. */
  size(): number;
  reset(): void;
}

export function createThrottle(options: ThrottleOptions): Throttle {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError("throttle windowMs must be a positive number");
  }
  if (!Number.isInteger(options.max) || options.max < 1) {
    throw new RangeError("throttle max must be a positive integer");
  }

  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { windowStart: number; count: number }>();

  const prune = (currentWindowStart: number): void => {
    // Opportunistic: only when the map grew past the cap. Dropping keys from
    // other windows is safe — their next attempt starts a fresh bucket anyway.
    if (buckets.size <= maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (bucket.windowStart !== currentWindowStart) buckets.delete(key);
    }
  };

  return {
    attempt(key: string): ThrottleVerdict {
      const nowMs = now();
      const windowStart = Math.floor(nowMs / options.windowMs) * options.windowMs;
      const retryAfterMs = windowStart + options.windowMs - nowMs;

      const bucket = buckets.get(key);
      if (!bucket || bucket.windowStart !== windowStart) {
        prune(windowStart);
        buckets.set(key, { windowStart, count: 1 });
        return { allowed: options.max >= 1, remaining: Math.max(0, options.max - 1), retryAfterMs };
      }

      bucket.count += 1;
      return {
        allowed: bucket.count <= options.max,
        remaining: Math.max(0, options.max - bucket.count),
        retryAfterMs,
      };
    },

    size(): number {
      return buckets.size;
    },

    reset(): void {
      buckets.clear();
    },
  };
}
