// =============================================================================
// lib/auth/require.ts — server-side session access for React Server Components.
//
// THE MIDDLEWARE IS NOT THE AUTHORITY
// ----------------------------------
// `middleware.ts` is the first gate: it redirects fast, before any rendering.
// But a matcher typo, a missing entry in `config.matcher`, or a future refactor
// would silently stop it from running, and then the ONLY thing between an
// anonymous request and /admin would be gone. Every protected page therefore
// calls `requireSession` / `requireStaffSession` itself.
//
// This module imports `next/headers` and therefore only runs on the server. It
// must never be imported by `middleware.ts`, which runs on the Edge Runtime.
// =============================================================================

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isStaffRole, landingPathForRole, LOGIN_PATH, PORTAL_LANDING, withNext } from "./guards";
import { SESSION_COOKIE, verifySessionToken, type SessionPayload } from "./session";

/**
 * The current session, or null.
 *
 * Never throws: an invalid, expired or tampered cookie is simply "no session".
 * A 500 here would be indistinguishable from a server fault to the user, and
 * the correct response to a stale cookie is to send them to /login.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}

/**
 * Require any authenticated session, or redirect to the login form.
 *
 * `next` is carried through the redirect so the user lands where they were
 * headed; it goes through `withNext`, which sanitises it against open
 * redirects.
 */
export async function requireSession(next?: string): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect(withNext(LOGIN_PATH, next ?? ""));
  return session;
}

/**
 * Require staff (ROOT or ADMIN), or redirect.
 *
 * A non-staff session is sent to /portal rather than to /login: it IS signed
 * in, and telling it otherwise would be a lie that costs the user a re-login.
 */
export async function requireStaffSession(next?: string): Promise<SessionPayload> {
  const session = await requireSession(next);
  if (!isStaffRole(session.role)) redirect(landingPathForRole(session.role) || PORTAL_LANDING);
  return session;
}