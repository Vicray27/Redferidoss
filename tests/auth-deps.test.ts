// =============================================================================
// tests/auth-deps.test.ts — lib/auth/deps.ts, the wiring seam of the login
// path (WU4).
//
// tests/auth-login.test.ts covers `authenticate()` over injected fakes; this
// file covers the REAL dependency object: which functions it delegates to and
// how the two F8 settings-backed numbers resolve — the session TTL (D17
// ceiling included) and the failed-login limit — because those are exactly
// the values a regression would silently hardcode again (§18.3).
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

const settingsMock = vi.hoisted(() => ({
  settings: {
    get: vi.fn(),
    getOrThrow: vi.fn(),
    invalidate: vi.fn(),
    peek: vi.fn(),
    size: vi.fn(),
  },
}));
const usersMock = vi.hoisted(() => ({ users: { findByIdentifier: vi.fn() } }));
const passwordMock = vi.hoisted(() => ({
  verifyPassword: vi.fn(),
  burnVerificationTime: vi.fn(),
}));

vi.mock("@/lib/settings", () => settingsMock);
vi.mock("@/lib/users", () => usersMock);
vi.mock("@/lib/password", () => passwordMock);
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  loginDeps,
  loginRateLimiter,
  resolveLoginMaxFailures,
  resolveSessionTtlSeconds,
} from "../lib/auth/deps";
import { SESSION_TTL_SECONDS } from "../lib/auth/session";
import { SecuritySettingInvalidError, SETTING_LOGIN_RATE_LIMIT } from "../lib/security-settings";
import { SETTING_SESSION_TTL_HOURS } from "../lib/security-settings";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveSessionTtlSeconds (F8, D17)", () => {
  it("uses the settings value converted to seconds", async () => {
    settingsMock.settings.get.mockResolvedValue(6);

    await expect(resolveSessionTtlSeconds()).resolves.toBe(6 * 60 * 60);
    expect(settingsMock.settings.get).toHaveBeenCalledWith(SETTING_SESSION_TTL_HOURS);
  });

  it("clamps values above the 8 h ceiling instead of rejecting them", async () => {
    settingsMock.settings.get.mockResolvedValue(720); // pre-F8 catalog value

    await expect(resolveSessionTtlSeconds()).resolves.toBe(SESSION_TTL_SECONDS);
  });

  it("falls back to the 8 h default WITH a warning when the key is missing", async () => {
    settingsMock.settings.get.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveSessionTtlSeconds()).resolves.toBe(SESSION_TTL_SECONDS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SETTING_SESSION_TTL_HOURS));
  });

  it("throws loudly on a value that cannot be an integer (no silent default)", async () => {
    settingsMock.settings.get.mockResolvedValue("abc");

    await expect(resolveSessionTtlSeconds()).rejects.toThrow(SecuritySettingInvalidError);
  });

  it("throws on zero or negative hours", async () => {
    settingsMock.settings.get.mockResolvedValue(0);

    await expect(resolveSessionTtlSeconds()).rejects.toThrow(SecuritySettingInvalidError);
  });
});

describe("resolveLoginMaxFailures (F8)", () => {
  it("reads security.login_rate_limit_per_15m through the validator", async () => {
    settingsMock.settings.getOrThrow.mockResolvedValue(10);

    await expect(resolveLoginMaxFailures()).resolves.toBe(10);
    expect(settingsMock.settings.getOrThrow).toHaveBeenCalledWith(SETTING_LOGIN_RATE_LIMIT);
  });

  it("accepts a numeric string, the shape a raw SQL write can produce", async () => {
    settingsMock.settings.getOrThrow.mockResolvedValue("15");

    await expect(resolveLoginMaxFailures()).resolves.toBe(15);
  });

  it("rejects a zero limit as a misconfiguration", async () => {
    settingsMock.settings.getOrThrow.mockResolvedValue(0);

    await expect(resolveLoginMaxFailures()).rejects.toThrow(SecuritySettingInvalidError);
  });
});

describe("loginDeps", () => {
  it("delegates the identifier lookup to lib/users", async () => {
    const user = { id: "u-1" };
    usersMock.users.findByIdentifier.mockResolvedValue(user);

    await expect(loginDeps.findUserByIdentifier("V-00000001")).resolves.toBe(user);
    expect(usersMock.users.findByIdentifier).toHaveBeenCalledWith("V-00000001");
  });

  it("uses the real verifyPassword and burn implementations", () => {
    expect(loginDeps.verifyPassword).toBe(passwordMock.verifyPassword);
    expect(loginDeps.burn).toBe(passwordMock.burnVerificationTime);
  });

  it("issues a token whose lifetime follows the same settings value", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(40));
    settingsMock.settings.get.mockResolvedValue(2);

    const token = await loginDeps.issueToken({
      userId: "11111111-1111-4111-8111-111111111111",
      role: "MEMBER",
      publicCode: "ABC123",
      fullName: "Ana",
    });

    // A signed JWT: three dot-separated segments.
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });
});

describe("loginRateLimiter", () => {
  it("is the persistent limiter over the rate_limits table", () => {
    expect(typeof loginRateLimiter.current).toBe("function");
    expect(typeof loginRateLimiter.recordFailure).toBe("function");
    expect(typeof loginRateLimiter.reset).toBe("function");
    expect(loginRateLimiter.keyFor("Ana@Example.com")).toMatch(/^login:[0-9a-f]{32}$/);
    // Same address, different formatting -> same storage key.
    expect(loginRateLimiter.keyFor(" ana@example.com ")).toBe(
      loginRateLimiter.keyFor("ANA@EXAMPLE.COM"),
    );
  });
});
