// =============================================================================
// lib/auth/login.ts — the credential decision, as a pure function.
//
// `authenticate()` contains no Next.js import, no cookie write and no Prisma
// call. Everything it touches arrives through `LoginDeps`, so
// `tests/auth-login.test.ts` can drive every branch — including the timing and
// enumeration defences — without a database and without argon2 running.
//
// lib/auth/actions.ts is the thin wrapper that adds the real dependencies and
// writes the cookie. Keeping the split here means the security-relevant logic
// is testable in isolation rather than only through a rendered page.
//
// ---------------------------------------------------------------------------
// Three defences that are easy to get wrong, so they are explicit here
// ---------------------------------------------------------------------------
// 1. NO USER ENUMERATION. A wrong email and a wrong password return the exact
//    same message. Distinguishing them turns /login into an account-existence
//    oracle.
// 2. TIMING EQUALISATION. When the email is unknown there is no hash to verify,
//    so the request would return in microseconds and leak existence through
//    timing. `burn` performs a real argon2 verification against a dummy hash,
//    making the two paths cost the same.
// 3. STATUS IS CHECKED AFTER THE PASSWORD. A suspended user gets an accurate
//    message, but only to someone who already proved they hold the password —
//    so the accurate message cannot be used to probe for accounts.
// =============================================================================

import type { AuthUserRow, UserRole } from "../users";
import type { SessionPayload } from "./session";

/**
 * Shown for a wrong email AND a wrong password. Never vary one without the
 * other: that is what turns the form into an enumeration oracle.
 */
export const INVALID_CREDENTIALS_MESSAGE = "Correo o contraseña incorrectos.";

/** Only ever shown to a caller who already supplied the correct password. */
export const ACCOUNT_SUSPENDED_MESSAGE =
  "Tu cuenta está suspendida. Contacta al administrador.";

/**
 * Shown when login is impossible because of server configuration. Deliberately
 * vague: the specific reason (missing AUTH_SECRET) is logged server-side, where
 * an operator will see it, and is not echoed to an anonymous caller.
 */
export const AUTH_UNAVAILABLE_MESSAGE =
  "No es posible iniciar sesión en este momento. Contacta al administrador.";

export interface LoginDeps {
  findUserByEmail(email: string): Promise<AuthUserRow | null>;
  verifyPassword(storedHash: string, plain: string): Promise<boolean>;
  /**
   * Spends roughly the same CPU as a real verification. Must be called (and
   * awaited) on the "user not found" path, or the response time leaks whether
   * the account exists.
   */
  burn(password: string): Promise<void>;
  issueToken(payload: SessionPayload): Promise<string>;
}

export type LoginOutcome =
  | { ok: true; token: string; payload: SessionPayload }
  | { ok: false; message: string };

/**
 * Verify credentials and mint a session token, or explain the refusal.
 *
 * The caller MUST validate the input with `loginSchema` first; this function
 * assumes `email` and `password` are non-empty strings and deliberately does
 * not repeat that validation.
 */
export async function authenticate(
  email: string,
  password: string,
  deps: LoginDeps,
): Promise<LoginOutcome> {
  const user = await deps.findUserByEmail(email);

  if (!user) {
    // Defence 2: equalise timing before giving up.
    await deps.burn(password);
    return { ok: false, message: INVALID_CREDENTIALS_MESSAGE };
  }

  const passwordMatches = await deps.verifyPassword(user.passwordHash, password);

  if (!passwordMatches) {
    // Defence 1: identical message to the "no such user" branch above.
    return { ok: false, message: INVALID_CREDENTIALS_MESSAGE };
  }

  // Defence 3: only now, with a proven password, is it safe to be specific.
  if (user.status === "SUSPENDED") {
    return { ok: false, message: ACCOUNT_SUSPENDED_MESSAGE };
  }

  const payload = toSessionPayload(user);
  const token = await deps.issueToken(payload);
  return { ok: true, token, payload };
}

/** Map a user row to the claims the session carries. */
export function toSessionPayload(user: AuthUserRow): SessionPayload {
  return {
    userId: user.id,
    role: user.role as UserRole,
    publicCode: user.publicCode,
    fullName: user.fullName,
  };
}