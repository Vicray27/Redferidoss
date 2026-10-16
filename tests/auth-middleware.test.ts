import { describe, expect, it } from "vitest";

import { needsSessionCheck, resolveRouteGuard, safeNextPath, withNext } from "../lib/auth/guards";
import { signSessionToken, type SessionPayload } from "../lib/auth/session";

/**
 * Integration coverage for the middleware's CONFIG, not for Next's own
 * middleware runtime (which is exercised by `pnpm build` and by the deploy).
 *
 * Importing ./middleware under vitest would pull in `next/server`, so this
 * file asserts the things the middleware file itself owns and could get wrong:
 * which paths it claims to process, which of those actually spend a JWT
 * verification, and that the guarded areas are exactly the ones
 * `resolveRouteGuard` protects.
 *
 * F8 changed the contract deliberately: the matcher is now BROAD (every
 * response gets the §13 headers) and `needsSessionCheck` is what keeps the
 * session work scoped to /admin, /portal and /login. Both halves are pinned
 * here, because a regression in either direction is a security-relevant
 * change: a narrow matcher silently drops headers, and a broad
 * `needsSessionCheck` makes cron and health pay for verification.
 */

const PAYLOAD: SessionPayload = {
  userId: "8f2b5a1e-0000-4000-8000-000000000001",
  role: "ROOT",
  publicCode: "JJGYCMQ1",
  fullName: "Administrador ROOT",
};

const memberPayload: SessionPayload = { ...PAYLOAD, role: "MEMBER" };

/** Mirror of `config.matcher` in middleware.ts. Duplicated on purpose: if the
 *  real one changes, the coverage here must be re-examined deliberately. */
const MATCHER = ["/((?!_next/static|_next/image|favicon.ico).*)"];

/** Would the Next.js matcher run middleware for this pathname? */
function claimed(pathname: string): boolean {
  return MATCHER.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));
}

/** The paths this test considers guarded — the session-dependent surface. */
const GUARDED_PATHS = [
  "/admin",
  "/admin/settings",
  "/admin/nested/deep",
  "/portal",
  "/portal/settings",
  "/portal/nested/deep",
  "/login",
];

describe("middleware matcher", () => {
  it("claims the protected areas, the login page and the public surface (headers everywhere)", () => {
    for (const path of [
      "/admin",
      "/admin/settings",
      "/portal",
      "/portal/nested/deep",
      "/login",
      "/",
      "/r/CODE1",
      "/invite/some-token",
      "/api/health",
      "/api/cron/cycle:ensure",
    ]) {
      expect(claimed(path), `${path} must be claimed for security headers`).toBe(true);
    }
  });

  it("excludes Next's static assets, which are immutable and header-irrelevant", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(claimed(path), `${path} must bypass middleware`).toBe(false);
    }
  });

  it("gates JWT verification to the routing areas, preserving the no-JWT property for cron and health", () => {
    for (const path of GUARDED_PATHS) {
      expect(needsSessionCheck(path), `${path} must verify the session`).toBe(true);
    }
    for (const path of ["/", "/r/CODE1", "/invite/some-token", "/api/health", "/api/cron/cycle:ensure"]) {
      expect(needsSessionCheck(path), `${path} must skip JWT verification`).toBe(false);
    }
  });
});

describe("every guarded path is protected by the guard", () => {
  it("redirects an anonymous request for each guarded path", () => {
    for (const path of GUARDED_PATHS) {
      const decision = resolveRouteGuard(path, null);
      // /login is guarded so an ANONYMOUS visitor can reach it; the others
      // must bounce.
      const expected = path === "/login" ? "allow" : "redirect";
      expect(decision.kind, `${path} must be ${expected}`).toBe(expected);
    }
  });

  it("keeps a MEMBER out of every guarded /admin path", () => {
    for (const path of GUARDED_PATHS) {
      const decision = resolveRouteGuard(path, memberPayload);
      if (path.startsWith("/admin")) {
        expect(decision.kind, `${path} must refuse a MEMBER`).toBe("redirect");
      }
    }
  });
});

describe("end-to-end cookie handling", () => {
  it("a token minted for ROOT lets resolveRouteGuard admit /admin", async () => {
    process.env.AUTH_SECRET = "middleware-test-secret-abcdefghijklmnop-0123456789";
    const token = await signSessionToken(PAYLOAD);

    // What middleware.ts does: read the cookie, verify, decide.
    const session = await import("../lib/auth/session").then((m) => m.verifySessionToken(token));
    expect(session).not.toBeNull();
    expect(resolveRouteGuard("/admin", session)).toEqual({ kind: "allow" });
  });

  it("a tampered cookie resolves to no session and bounces to login", async () => {
    process.env.AUTH_SECRET = "middleware-test-secret-abcdefghijklmnop-0123456789";
    const token = await signSessionToken(PAYLOAD);
    const tampered = token.slice(0, -3) + "aaa";

    const session = await import("../lib/auth/session").then((m) => m.verifySessionToken(tampered));
    expect(session).toBeNull();
    expect(resolveRouteGuard("/admin", session)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fadmin",
      reason: "no-session",
    });
  });
});

describe("redirect target is always same-origin", () => {
  it("carries only sanitised paths into the login redirect", () => {
    expect(withNext("/login", "/admin/settings")).toBe("/login?next=%2Fadmin%2Fsettings");
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(resolveRouteGuard("/admin", null)).toMatchObject({
      to: expect.stringContaining("/login"),
    });
  });
});
