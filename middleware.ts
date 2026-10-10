// =============================================================================
// middleware.ts — first-pass routing gate for the two protected areas.
//
// Runs on the Edge Runtime before rendering, so it must stay cheap and must
// not reach the database. It only verifies the session token, which is why
// lib/auth/session.ts is deliberately Edge-safe.
//
// IT IS NOT THE AUTHORITY. It redirects; it does not authorize. Every
// protected page re-checks with `requireSession`/`requireStaffSession` from
// lib/auth/require.ts, so a mistake in the matcher below degrades to "one
// extra redirect", never to "anonymous access to /admin".
//
// Next 15.5 names this file `middleware.ts`. Next 16 renames it to `proxy.ts`;
// that is a rename of the file only, and the logic is identical.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";

import { resolveRouteGuard } from "@/lib/auth/guards";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  // verifySessionToken returns null for a bad signature, an expired token, a
  // tampered payload or an unusable AUTH_SECRET. All of those mean the same
  // thing here: treat the visitor as anonymous and redirect.
  const session = await verifySessionToken(token);
  const decision = resolveRouteGuard(request.nextUrl.pathname, session);

  if (decision.kind === "allow") return NextResponse.next();

  return NextResponse.redirect(new URL(decision.to, request.url));
}

export const config = {
  /**
   * Only the areas that need a session, plus /login (to bounce an
   * already-authenticated user to their landing). `/api/*` is deliberately
   * absent: it already has its own authentication, and matching it here would
   * make every cron call pay for JWT verification.
   *
   * A typo in this list would weaken the fast redirect, not the protection —
   * that is exactly why lib/auth/require.ts exists.
   */
  matcher: ["/admin/:path*", "/portal/:path*", "/login"],
};