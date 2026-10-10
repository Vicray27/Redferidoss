// =============================================================================
// lib/auth/guards.ts — role and route authorization, as PURE functions.
//
// Everything here is a total function of its arguments: no database, no
// cookies, no `next/*` imports. That is deliberate, and it is what makes the
// authorization decision unit-testable in isolation, and safe to import from
// `middleware.ts` (Edge Runtime) as well as from React Server Components.
//
// Three separate concerns live here, kept apart on purpose:
//   1. who counts as staff                       -> isStaffRole
//   2. where a role lands after login            -> landingPathForRole
//   3. whether a given request may proceed       -> resolveRouteGuard
//
// The middleware and the pages both call `resolveRouteGuard`, so there is a
// single decision to audit, and a role change cannot make the two disagree.
// The middleware is still only the FIRST gate: `lib/auth/require.ts` re-checks
// on the server for every protected page, because a matcher typo must never be
// the only thing standing between an anonymous request and /admin.
// =============================================================================

import type { UserRole } from "../users";

/** §5.1 roles that reach the back office. ROOT inherits ADMIN's reach. */
export const STAFF_ROLES: readonly UserRole[] = ["ROOT", "ADMIN"];

/** The session roles the UI understands. Anything else is not a session. */
export const SESSION_ROLES: readonly UserRole[] = ["ROOT", "ADMIN", "MEMBER"];

/** Back office root. ROOT and ADMIN land here. */
export const ADMIN_LANDING = "/admin";

/** Member-facing root. Everyone else lands here. */
export const PORTAL_LANDING = "/portal";

/** Where an unauthenticated request is sent, with the intended path kept. */
export const LOGIN_PATH = "/login";

export function isStaffRole(role: UserRole): boolean {
  return role === "ROOT" || role === "ADMIN";
}

/** ROLE -> landing. ROOT/ADMIN to /admin, everyone else to /portal (D15). */
export function landingPathForRole(role: UserRole): string {
  return isStaffRole(role) ? ADMIN_LANDING : PORTAL_LANDING;
}

/**
 * Reduce anything URL-shaped to a bare pathname.
 *
 * This is a SECURITY normalisation, not tidiness. Every predicate below does an
 * exact or prefix comparison, so `/admin?tab=x` and `/admin#top` would slip
 * through both: `"/admin?tab=x" === "/admin"` is false, and it does not start
 * with `"/admin/"` either. A caller that passed `request.url` where
 * `request.nextUrl.pathname` was expected would therefore disable the /admin
 * guard completely, and nothing would fail loudly.
 *
 * Idempotent, so applying it in both the predicates and `resolveRouteGuard`
 * costs nothing.
 */
export function toPathname(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** True for `/admin` and anything under it. Query strings do not hide it. */
export function isAdminPath(url: string): boolean {
  const pathname = toPathname(url);
  return pathname === ADMIN_LANDING || pathname.startsWith(`${ADMIN_LANDING}/`);
}

/** True for `/portal` and anything under it. Query strings do not hide it. */
export function isPortalPath(url: string): boolean {
  const pathname = toPathname(url);
  return pathname === PORTAL_LANDING || pathname.startsWith(`${PORTAL_LANDING}/`);
}

/**
 * Sanitise the `?next=` value coming back from a redirect.
 *
 * This is an OPEN-REDIRECT guard, not a convenience: without it, visiting
 * `/login?next=//evil.example` and logging in would bounce the user to an
 * attacker-controlled origin with a valid session cookie in hand. Only a
 * same-origin absolute path is allowed.
 *
 * Rejected: protocol-relative (`//host`, `/\host`), absolute URLs, anything
 * with a scheme, and anything not starting with a single `/`. Backslashes are
 * rejected too because several browsers normalise `\` to `/` in a Location
 * header, which would re-open the hole this closes.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "" || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || value.includes("\n") || value.includes("\r")) return null;
  // No scheme can survive the checks above, but be explicit rather than clever.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value;
}

/** The minimum a session must carry for a routing decision to be made. */
export interface GuardSubject {
  role: UserRole;
}

/**
 * The routing decision for one request.
 *
 * - `allow`: proceed.
 * - `redirect`: go to `to`. `reason` exists for logs and tests, never for the
 *   user-facing message (which would leak why access was refused).
 */
export type RouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; reason: GuardReason };

export type GuardReason = "no-session" | "not-staff" | "already-authenticated";

/**
 * Decide what happens for `pathname` given an optional session.
 *
 * Rules, in order:
 *   1. No session on /admin or /portal -> /login?next=<pathname>.
 *   2. No session on /login itself     -> /login (render the form).
 *   3. A session on /login             -> the role's landing, so a logged-in
 *      user never sees the form again.
 *   4. A non-staff session on /admin   -> /portal, not /login: the user IS
 *      authenticated, they simply belong on the other side.
 */
export function resolveRouteGuard(
  url: string,
  subject: GuardSubject | null,
): RouteDecision {
  const pathname = toPathname(url);
  const protectedArea = isAdminPath(pathname) || isPortalPath(pathname);
  const isLogin = pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);

  if (!subject) {
    if (protectedArea) {
      return { kind: "redirect", to: withNext(LOGIN_PATH, pathname), reason: "no-session" };
    }
    return { kind: "allow" };
  }

  if (isLogin) {
    return { kind: "redirect", to: landingPathForRole(subject.role), reason: "already-authenticated" };
  }

  if (isAdminPath(pathname) && !isStaffRole(subject.role)) {
    return { kind: "redirect", to: PORTAL_LANDING, reason: "not-staff" };
  }

  return { kind: "allow" };
}

/** Build `/login?next=…`, sanitising the value on the way in. */
export function withNext(loginPath: string, pathname: string): string {
  const safe = safeNextPath(pathname);
  return safe ? `${loginPath}?next=${encodeURIComponent(safe)}` : loginPath;
}