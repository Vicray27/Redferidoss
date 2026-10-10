import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The middleware redirects; the PAGES authorize. This file tests the second
 * half, which is the half that actually protects /admin.
 *
 * `next/headers` and `next/navigation` are mocked so the server-only helpers
 * can run in vitest with no framework and no database: the cookie is just a
 * string and the token is signed by the real jose path.
 */

// Next's real redirect() throws a framework-specific error that aborts the
// render. Reproduce that with a sentinel so a redirect is observable.
const REDIRECT = Symbol("next.redirect");
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw { __redirect: REDIRECT, to };
  },
}));

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "red_session" ? { value: cookieValue } : undefined) }),
}));

// Static imports are safe here: vitest hoists vi.mock above them, so these
// modules already see the mocked next/* when they are evaluated.
import { getSession, requireSession, requireStaffSession } from "../lib/auth/require";
import { SESSION_COOKIE, signSessionToken, type SessionPayload } from "../lib/auth/session";

const SECRET = "require-test-secret-abcdefghijklmnopqrstuvwxyz-0123456789";

const base: SessionPayload = {
  userId: "8f2b5a1e-0000-4000-8000-000000000001",
  role: "ROOT",
  publicCode: "JJGYCMQ1",
  fullName: "Administrador ROOT",
};

async function cookieFor(payload: SessionPayload): Promise<string> {
  return signSessionToken(payload);
}

/** Capture the destination a helper redirected to, or null when it returned. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error && (error as { __redirect?: symbol }).__redirect === REDIRECT) {
      return (error as { to: string }).to;
    }
    throw error;
  }
}

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET;
  cookieValue = undefined;
});

describe("getSession", () => {
  it("returns null when no cookie is present", async () => {
    await expect(getSession()).resolves.toBeNull();
  });

  it("returns null for a tampered cookie instead of throwing", async () => {
    // A stale or hand-edited cookie must produce a login redirect, not a 500.
    const token = await cookieFor(base);
    cookieValue = `${token.slice(0, -4)}zzzz`;
    await expect(getSession()).resolves.toBeNull();
  });

  it("returns null when AUTH_SECRET is unusable", async () => {
    cookieValue = await cookieFor(base);
    delete process.env.AUTH_SECRET;
    await expect(getSession()).resolves.toBeNull();
  });

  it("returns the payload for a valid cookie", async () => {
    cookieValue = await cookieFor(base);
    await expect(getSession()).resolves.toEqual(base);
  });
});

describe("requireSession — the page-level authority", () => {
  it("redirects to /login when there is no cookie", async () => {
    await expect(captureRedirect(() => requireSession("/admin"))).resolves.toBe("/login?next=%2Fadmin");
  });

  it("redirects with no next when the caller did not pass one", async () => {
    await expect(captureRedirect(() => requireSession())).resolves.toBe("/login");
  });

  it("sanitises the next value instead of echoing an attacker URL", async () => {
    // A compromised or stale link must not be able to turn the login redirect
    // into an off-site hop.
    await expect(captureRedirect(() => requireSession("//evil.example"))).resolves.toBe("/login");
  });

  it("returns the session when the cookie is valid", async () => {
    cookieValue = await cookieFor(base);
    await expect(requireSession("/admin")).resolves.toEqual(base);
  });
});

describe("requireStaffSession — /admin is closed to MEMBER", () => {
  it("admits ROOT", async () => {
    cookieValue = await cookieFor(base);
    await expect(requireStaffSession("/admin")).resolves.toEqual(base);
  });

  it("admits ADMIN", async () => {
    cookieValue = await cookieFor({ ...base, role: "ADMIN" });
    await expect(requireStaffSession("/admin")).resolves.toMatchObject({ role: "ADMIN" });
  });

  it("sends a MEMBER to /portal, NOT to /login", async () => {
    cookieValue = await cookieFor({ ...base, role: "MEMBER" });
    // /login would tell an authenticated user their session had expired.
    await expect(captureRedirect(() => requireStaffSession("/admin"))).resolves.toBe("/portal");
  });

  it("sends an anonymous visitor to /login with the intended path", async () => {
    await expect(captureRedirect(() => requireStaffSession("/admin"))).resolves.toBe(
      "/login?next=%2Fadmin",
    );
  });

  it("refuses a MEMBER whose token is validly signed for another area", async () => {
    // The token is genuine; the ROLE is what disqualifies it. Proves the check
    // reads the verified claims rather than the cookie's presence.
    cookieValue = await cookieFor({ ...base, role: "MEMBER" });
    expect(await captureRedirect(() => requireStaffSession("/admin"))).toBe("/portal");
  });
});

describe("the cookie name is a single shared constant", () => {
  it("matches what middleware reads and what the action writes", async () => {
    expect(SESSION_COOKIE).toBe("red_session");
  });
});