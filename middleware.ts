// =============================================================================
// middleware.ts — first-pass routing gate for the two protected areas, and the
// one place the §13 security headers are attached to every response.
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
// F8: the matcher is BROAD (everything except Next's static assets), because
// headers must reach API responses, the public pages and redirects alike —
// a header that only reaches some responses is not a policy. The cost is kept
// at zero where it matters: `needsSessionCheck` gates the JWT verification, so
// /api/* and the public pages skip every crypto call they used to skip under
// the old narrow matcher.
//
// The nonce-based CSP follows the Next.js recipe: the policy travels on the
// REQUEST headers (together with `x-nonce`) and Next stamps the nonce onto the
// scripts and styles it renders; the same policy also goes out on the
// RESPONSE for the browser to enforce. See lib/security-headers.ts.
//
// Next 15.5 names this file `middleware.ts`. Next 16 renames it to `proxy.ts`;
// that is a rename of the file only, and the logic is identical.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";

import { needsSessionCheck, resolveRouteGuard } from "@/lib/auth/guards";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import {
  CSP_HEADER,
  NONCE_HEADER,
  buildContentSecurityPolicy,
  createNonce,
  securityHeadersFor,
} from "@/lib/security-headers";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const isProduction = process.env.NODE_ENV === "production";
  const nonce = createNonce();
  const headers = securityHeadersFor(nonce, { isProduction });
  const csp = headers[CSP_HEADER] ?? buildContentSecurityPolicy(nonce, isProduction);

  const attach = (response: NextResponse): NextResponse => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };

  // `NextResponse.next` cannot set request headers after construction; the
  // documented shape is to build it with the amended request headers.
  const proceed = (): NextResponse => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(NONCE_HEADER, nonce);
    requestHeaders.set(CSP_HEADER, csp);
    return attach(NextResponse.next({ request: { headers: requestHeaders } }));
  };

  const pathname = request.nextUrl.pathname;

  // Public surface: no token work at all (cron and health keep their no-JWT
  // property), but the headers still go out.
  if (!needsSessionCheck(pathname)) return proceed();

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  // verifySessionToken returns null for a bad signature, an expired token, a
  // tampered payload or an unusable AUTH_SECRET. All of those mean the same
  // thing here: treat the visitor as anonymous and redirect.
  const session = await verifySessionToken(token);
  const decision = resolveRouteGuard(pathname, session);

  if (decision.kind === "allow") return proceed();

  return attach(NextResponse.redirect(new URL(decision.to, request.url)));
}

export const config = {
  /**
   * Everything except Next's immutable static assets: the security headers are
   * a policy for ALL responses (§13), and `needsSessionCheck` keeps the
   * session verification scoped to the three areas that need it. A typo here
   * would still only weaken the fast redirect, never the protection — that is
   * exactly why lib/auth/require.ts exists.
   *
   * The negative lookahead mirrors the Next.js CSP recipe, so `_next/static`,
   * `_next/image` and `favicon.ico` bypass middleware entirely.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
