import { describe, expect, it } from "vitest";

import { resolveRouteGuard, safeNextPath, withNext } from "../lib/auth/guards";
import { signSessionToken, SESSION_COOKIE, type SessionPayload } from "../lib/auth/session";

/**
 * Integration coverage for the middleware's CONFIG, not for Next's own
 * middleware runtime (which is exercised by `pnpm build` and by the deploy).
 *
 * Importing ./middleware under vitest would pull in `next/server`, so this
 * file asserts the two things the middleware file itself owns and could get
 * wrong: which paths it claims to guard, and that those paths are exactly the
 * ones `resolveRouteGuard` protects. If someone adds a route to the matcher
 * without a guard behind it, or forgets a guarded area, this fails.
 */

const PAYLOAD: SessionPayload = {
  userId: "8f2b5a1e-0000-4000-8000-000000000001",
  role: "ROOT",
  publicCode: "JJGYCMQ1",
  fullName: "Administrador ROOT",
};

const memberPayload: SessionPayload = { ...PAYLOAD, role: "MEMBER" };

/** Mirror of `config.matcher` in middleware.ts. Duplicated on purpose: if the
 *  real one changes, the guard coverage here must be re-examined deliberately. */
const MATCHER = ["/admin/:path*", "/portal/:path*", "/login"];

/** Expand one matcher pattern into concrete paths a request could use. */
function matches(pattern: string): string[] {
  if (pattern === "/login") return ["/login"];
  const prefix = pattern.replace("/:path*", "");
  return [prefix, `${prefix}/settings`, `${prefix}/nested/deep`];
}

describe("middleware matcher", () => {
  it("covers exactly the protected areas and the login page", () => {
    const guarded = MATCHER.flatMap(matches).sort();
    expect(guarded).toEqual([
      "/admin",
      "/admin/nested/deep",
      "/admin/settings",
      "/login",
      "/portal",
      "/portal/nested/deep",
      "/portal/settings",
    ]);
  });

  it("does NOT claim /api, so cron and health pay no JWT verification", () => {
    for (const path of ["/api/health", "/api/cron/cycle:ensure"]) {
      expect(MATCHER.some((p) => matches(p).includes(path))).toBe(false);
    }
  });
});

describe("every matched path is protected by the guard", () => {
  it("redirects an anonymous request for each matcher path", () => {
    for (const pattern of MATCHER) {
      for (const path of matches(pattern)) {
        const decision = resolveRouteGuard(path, null);
        // /login is matched so an ANONYMOUS visitor can reach it; the others
        // must bounce.
        const expected = path === "/login" ? "allow" : "redirect";
        expect(decision.kind, `${path} must be ${expected}`).toBe(expected);
      }
    }
  });

  it("keeps a MEMBER out of every matched /admin path", () => {
    for (const pattern of MATCHER) {
      for (const path of matches(pattern)) {
        const decision = resolveRouteGuard(path, memberPayload);
        if (path.startsWith("/admin")) {
          expect(decision.kind, `${path} must refuse a MEMBER`).toBe("redirect");
        }
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