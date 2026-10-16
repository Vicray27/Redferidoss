// =============================================================================
// lib/auth/deps.ts — wires `authenticate()` to the real implementations.
//
// Kept out of lib/auth/actions.ts on purpose: a `"use server"` module may only
// export async functions, so the dependency object cannot live there. This
// file is also the single place where the login path touches Prisma, argon2
// and the signer, which makes the boundary easy to audit.
//
// F8 moved the two business numbers this path used to hardcode into settings
// (§18.3): the failed-login limit (`security.login_rate_limit_per_15m`) and
// the session lifetime (`security.session_ttl_hours`, clamped by D17). Both
// resolvers live here so the Server Action and the cookie maxAge cannot
// disagree about which value is authoritative.
// =============================================================================

import { prisma } from "../db";
import { burnVerificationTime, verifyPassword } from "../password";
import {
  readLoginMaxFailures,
  SETTING_SESSION_TTL_HOURS,
} from "../security-settings";
import { settings } from "../settings";
import { users } from "../users";

import type { LoginDeps } from "./login";
import { createLoginRateLimiter } from "./rate-limit";
import {
  SESSION_TTL_MAX_HOURS,
  SESSION_TTL_SECONDS,
  sessionTtlSecondsFromHours,
  signSessionToken,
} from "./session";

/**
 * The session lifetime to use right now, in seconds.
 *
 * Missing key -> the 8 h default with a warning (a fresh environment before
 * `pnpm seed:root` must still be able to log in); present but unusable ->
 * throws, loudly. The settings reader caches for 60 s (D9), so this is not a
 * per-request round trip.
 */
export async function resolveSessionTtlSeconds(): Promise<number> {
  const raw = await settings.get<unknown>(SETTING_SESSION_TTL_HOURS);
  if (raw === null) {
    console.warn(
      `[auth] "${SETTING_SESSION_TTL_HOURS}" is missing; using the ${SESSION_TTL_MAX_HOURS} h default. ` +
        `Seed it with "pnpm seed:root".`,
    );
    return SESSION_TTL_SECONDS;
  }
  return sessionTtlSecondsFromHours(raw);
}

/** The failed-login limit from settings: `security.login_rate_limit_per_15m`. */
export async function resolveLoginMaxFailures(): Promise<number> {
  return readLoginMaxFailures(settings);
}

/** The real credential-check dependencies. */
export const loginDeps: LoginDeps = {
  findUserByEmail: (email) => users.findByEmail(email),
  verifyPassword,
  burn: burnVerificationTime,
  // The token's own `exp` follows the same settings-derived lifetime as the
  // cookie's `maxAge`, so one setting governs both ends of the session.
  issueToken: async (payload) =>
    signSessionToken(payload, { ttlSeconds: await resolveSessionTtlSeconds() }),
};

/** The real failed-attempt throttle, over the `rate_limits` table from §5.9. */
export const loginRateLimiter = createLoginRateLimiter(prisma);
