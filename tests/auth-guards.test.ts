import { describe, expect, it } from "vitest";

import {
  ADMIN_LANDING,
  isAdminPath,
  isPortalPath,
  isStaffRole,
  landingPathForRole,
  LOGIN_PATH,
  PORTAL_LANDING,
  resolveRouteGuard,
  safeNextPath,
  toPathname,
  withNext,
  type GuardSubject,
} from "../lib/auth/guards";

/**
 * No database and no framework: every function here is a total function of its
 * arguments. These are the tests that decide WHO may enter WHICH area, so they
 * assert the refusals as loudly as the allowances.
 */

const root: GuardSubject = { role: "ROOT" };
const admin: GuardSubject = { role: "ADMIN" };
const member: GuardSubject = { role: "MEMBER" };

describe("isStaffRole", () => {
  it("treats ROOT and ADMIN as back-office staff", () => {
    expect(isStaffRole("ROOT")).toBe(true);
    expect(isStaffRole("ADMIN")).toBe(true);
  });

  it("excludes MEMBER", () => {
    expect(isStaffRole("MEMBER")).toBe(false);
  });
});

describe("landingPathForRole", () => {
  it("sends ROOT and ADMIN to /admin", () => {
    expect(landingPathForRole("ROOT")).toBe("/admin");
    expect(landingPathForRole("ADMIN")).toBe("/admin");
  });

  it("sends everyone else to /portal", () => {
    expect(landingPathForRole("MEMBER")).toBe("/portal");
  });

  it("points both landings at areas the same role is actually allowed in", () => {
    // Guards against a future role that lands somewhere it cannot enter.
    for (const role of ["ROOT", "ADMIN", "MEMBER"] as const) {
      const landing = landingPathForRole(role);
      expect(resolveRouteGuard(landing, { role }).kind).toBe("allow");
    }
  });
});

describe("area predicates", () => {
  it("matches the area root and its descendants, not a prefix collision", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/referrals")).toBe(true);
    expect(isPortalPath("/portal")).toBe(true);
    expect(isPortalPath("/portal/payments")).toBe(true);

    expect(isAdminPath("/administration")).toBe(false);
    expect(isAdminPath("/portal")).toBe(false);
    expect(isPortalPath("/portals")).toBe(false);
  });

  it("cannot be evaded with a query string or a fragment", () => {
    // Guard-bypass class: every predicate below is an exact-or-prefix compare,
    // so without toPathname() these all return FALSE and /admin is unguarded.
    expect(isAdminPath("/admin?tab=referrals")).toBe(true);
    expect(isAdminPath("/admin/settings#top")).toBe(true);
    expect(isAdminPath("/admin/referrals?x=1")).toBe(true);
    expect(isPortalPath("/portal?tab=payments")).toBe(true);

    // ...while the prefix collision is still rejected after stripping.
    expect(isAdminPath("/administration?x=1")).toBe(false);
    expect(isAdminPath("/portals?x=1")).toBe(false);
  });

  it("toPathname is idempotent and keeps the query out of comparisons", () => {
    expect(toPathname("/admin?x=1")).toBe("/admin");
    expect(toPathname("/admin#x")).toBe("/admin");
    expect(toPathname("/admin")).toBe("/admin");
    expect(toPathname(toPathname("/admin?x=1"))).toBe("/admin");
  });
});

describe("safeNextPath — open-redirect guard", () => {
  it("accepts a same-origin absolute path", () => {
    expect(safeNextPath("/admin")).toBe("/admin");
    expect(safeNextPath("/portal/payments?tab=open")).toBe("/portal/payments?tab=open");
  });

  it("rejects protocol-relative URLs", () => {
    // /login?next=//evil.example would send a freshly authenticated user to an
    // attacker origin. This is the whole reason the function exists.
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("//evil.example/steal")).toBeNull();
  });

  it("rejects the backslash variants browsers normalise to a host", () => {
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("/foo\\bar")).toBeNull();
  });

  it("rejects absolute URLs and anything carrying a scheme", () => {
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("http:/\/evil.example")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("data:text/html,x")).toBeNull();
  });

  it("rejects relative paths, which would resolve against the current origin", () => {
    expect(safeNextPath("admin")).toBeNull();
    expect(safeNextPath("../admin")).toBeNull();
  });

  it("rejects header-injection attempts and empty input", () => {
    expect(safeNextPath("/admin\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/admin\r\nX: 1")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath("   ")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe("withNext", () => {
  it("carries the intended path through login, URL-encoded", () => {
    expect(withNext(LOGIN_PATH, "/portal/payments")).toBe(
      "/login?next=%2Fportal%2Fpayments",
    );
  });

  it("drops an unsafe path instead of propagating it", () => {
    expect(withNext(LOGIN_PATH, "//evil.example")).toBe(LOGIN_PATH);
  });
});

describe("resolveRouteGuard — anonymous visitors", () => {
  it("bounces /admin to login and remembers where they were going", () => {
    const decision = resolveRouteGuard("/admin", null);
    expect(decision).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fadmin",
      reason: "no-session",
    });
  });

  it("bounces /portal and its sub-paths the same way", () => {
    expect(resolveRouteGuard("/portal/payments", null).kind).toBe("redirect");
  });

  it("lets an anonymous visitor see the login form itself", () => {
    expect(resolveRouteGuard("/login", null)).toEqual({ kind: "allow" });
  });

  it("does not guard unrelated public routes", () => {
    expect(resolveRouteGuard("/", null)).toEqual({ kind: "allow" });
    expect(resolveRouteGuard("/api/health", null)).toEqual({ kind: "allow" });
  });
});

describe("resolveRouteGuard — authenticated users", () => {
  it("allows staff into /admin", () => {
    expect(resolveRouteGuard("/admin", root)).toEqual({ kind: "allow" });
    expect(resolveRouteGuard("/admin", admin)).toEqual({ kind: "allow" });
  });

  it("allows staff into /portal too, they are simply not sent there", () => {
    expect(resolveRouteGuard("/portal", admin).kind).toBe("allow");
  });

  it("refuses a MEMBER on /admin and sends them to /portal, not to /login", () => {
    // The user IS authenticated; bouncing them to /login would be a lie and
    // would make them think their session expired.
    expect(resolveRouteGuard("/admin", member)).toEqual({
      kind: "redirect",
      to: PORTAL_LANDING,
      reason: "not-staff",
    });
  });

  it("allows a MEMBER on /portal and its sub-paths", () => {
    expect(resolveRouteGuard("/portal", member)).toEqual({ kind: "allow" });
    expect(resolveRouteGuard("/portal/payments", member)).toEqual({ kind: "allow" });
  });

  it("sends a logged-in user away from /login to their own landing", () => {
    expect(resolveRouteGuard("/login", root)).toEqual({
      kind: "redirect",
      to: ADMIN_LANDING,
      reason: "already-authenticated",
    });
    expect(resolveRouteGuard("/login", member)).toEqual({
      kind: "redirect",
      to: PORTAL_LANDING,
      reason: "already-authenticated",
    });
  });

  it("ignores a next= parameter on /login: an authenticated user has no business there", () => {
    const decision = resolveRouteGuard("/login?next=/admin", root);
    // The query string must not defeat the "already signed in" rule.
    expect(decision).toEqual({
      kind: "redirect",
      to: ADMIN_LANDING,
      reason: "already-authenticated",
    });
  });

  it("cannot be evaded on /admin with a query string or a fragment", () => {
    expect(resolveRouteGuard("/admin?tab=x", member)).toEqual({
      kind: "redirect",
      to: PORTAL_LANDING,
      reason: "not-staff",
    });
    expect(resolveRouteGuard("/admin/settings", member).kind).toBe("redirect");
    expect(resolveRouteGuard("/admin?tab=x", null)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fadmin",
      reason: "no-session",
    });
    expect(resolveRouteGuard("/portal?tab=x", null)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fportal",
      reason: "no-session",
    });
  });

  it("does not let a query string smuggle the user past the landing target", () => {
    // If `to` were built from the raw url, a crafted query could change where
    // the user is sent after authentication.
    const decision = resolveRouteGuard("/admin?next=//evil.example", member);
    expect(decision).toEqual({ kind: "redirect", to: PORTAL_LANDING, reason: "not-staff" });
  });
});

describe("resolveRouteGuard — exhaustive role x area matrix", () => {
  const areas = [ADMIN_LANDING, "/admin/referrals", PORTAL_LANDING, "/portal/payments"];
  const roles = ["ROOT", "ADMIN", "MEMBER"] as const;

  it("never allows a MEMBER into any /admin path", () => {
    for (const area of areas) {
      const decision = resolveRouteGuard(area, { role: "MEMBER" });
      if (area.startsWith("/admin")) {
        expect(decision).not.toEqual({ kind: "allow" });
      }
    }
  });

  it("never refuses a ROOT from either area", () => {
    for (const area of areas) {
      expect(resolveRouteGuard(area, root)).toEqual({ kind: "allow" });
    }
  });
});