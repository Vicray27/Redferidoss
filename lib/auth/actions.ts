// =============================================================================
// lib/auth/actions.ts — the Server Actions behind the login form.
//
// A Server Action, not a POST route handler, for one concrete reason: Next
// verifies the Origin/Host of every Server Action call, which is the CSRF
// defence the login mutation needs. A hand-rolled `POST /api/auth/login`
// would have to implement that check itself.
//
// `"use server"` modules may only export async FUNCTIONS — so the dependency
// wiring lives in lib/auth/deps.ts and every exported type below is erased at
// compile time.
//
// Validation runs here even though the form already validates on the client.
// Client validation is a UX affordance; the client is not a trust boundary, and
// the two share `loginSchema` so they cannot disagree about what is valid.
// =============================================================================

"use server";

import { cookies } from "next/headers";

import { landingPathForRole, safeNextPath } from "./guards";
import {
  loginDeps,
  loginRateLimiter,
  resolveLoginMaxFailures,
  resolveSessionTtlSeconds,
} from "./deps";
import { authenticate, AUTH_UNAVAILABLE_MESSAGE } from "./login";
import { RATE_LIMITED_MESSAGE } from "./rate-limit";
import { firstIssuesByField, loginSchema } from "./schema";
import { AuthSecretError, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "./session";

export interface LoginResult {
  ok: boolean;
  /** Message to render above the form when `ok` is false. */
  message?: string;
  /** Per-field messages, so the form can mark the offending inputs. */
  fieldErrors?: Record<string, string>;
  /** Absolute same-origin path to navigate to after success. */
  redirectTo?: string;
}

export async function loginAction(
  input: { identifier: string; password: string },
  nextPath: string | null,
): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: firstIssuesByField(parsed.error) };
  }

  const identifier = parsed.data.identifier;

  try {
    // Throttle BEFORE spending argon2 time, so a brute-force run is cheap to
    // reject rather than expensive to serve. The threshold is read from
    // settings (§18.3); a missing or unusable row throws and surfaces as a 500
    // rather than silently using a stale hardcoded number.
    const maxFailures = await resolveLoginMaxFailures();
    if (await loginRateLimiter.current(identifier) >= maxFailures) {
      return { ok: false, message: RATE_LIMITED_MESSAGE };
    }

    const outcome = await authenticate(identifier, parsed.data.password, loginDeps);

    if (!outcome.ok) {
      // Only failures are counted. Counting every request would let anyone
      // lock a known user out with a handful of junk POSTs.
      await loginRateLimiter.recordFailure(identifier);
      return { ok: false, message: outcome.message };
    }

    // A success clears the counter, so a user who mistyped a few times is not
    // left one error away from being locked out.
    await loginRateLimiter.reset(identifier);

    // Where to send the user: the page they originally asked for when that is
    // safe, otherwise their role's landing. `safeNextPath` is what stops
    // `/login?next=//evil.example` from becoming an open redirect.
    const safeNext = safeNextPath(nextPath);
    const redirectTo =
      safeNext && !isDeniedByRole(safeNext, outcome.payload.role)
        ? safeNext
        : landingPathForRole(outcome.payload.role);

    (await cookies()).set(SESSION_COOKIE, outcome.token, {
      ...SESSION_COOKIE_OPTIONS,
      // Same settings-derived value the token's `exp` was minted with, so the
      // cookie and the claims expire together.
      maxAge: await resolveSessionTtlSeconds(),
    });

    return { ok: true, redirectTo };
  } catch (error) {
    // A broken AUTH_SECRET must NOT be reported as wrong credentials: the user
    // would retype a correct password forever. Log the real cause for the
    // operator and return something that points at the administrator.
    if (error instanceof AuthSecretError) {
      console.error("[auth] login unavailable:", error.message);
      return { ok: false, message: AUTH_UNAVAILABLE_MESSAGE };
    }
    throw error;
  }
}

/**
 * A staff-only path is not a valid destination for a MEMBER, even when the
 * middleware would happily bounce them to /portal afterwards. Refusing it here
 * avoids the round trip.
 */
function isDeniedByRole(path: string, role: string): boolean {
  return path === "/admin" && role === "MEMBER";
}

export async function logoutAction(): Promise<void> {
  // Expire the cookie with the same attributes it was set with, otherwise some
  // browsers keep the original one and the session survives the logout.
  (await cookies()).set(SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
}