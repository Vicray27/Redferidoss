import { describe, expect, it } from "vitest";

import type { SettingsLike } from "../lib/authz";
import {
  PASSWORD_MIN_LENGTH_FLOOR,
  SETTING_LOGIN_RATE_LIMIT,
  SETTING_MASK_SENSITIVE_FIELDS,
  SETTING_PASSWORD_MIN_LENGTH,
  SecuritySettingInvalidError,
  readLoginMaxFailures,
  readMaskSensitiveFields,
  readPasswordMinLength,
  readRegisterHourlyLimit,
  resolvePositiveInteger,
} from "../lib/security-settings";

/**
 * §18.3: "Ningún número de negocio en el código: leerlo de settings. Si falta
 * una clave, fallar de forma explícita con un mensaje claro."
 *
 * These tests pin the failing-loudly half of that contract: a missing key
 * throws (never a silent hardcoded fallback) and an unusable value names the
 * key in the message. The session TTL conversion this validator feeds is
 * tested in tests/auth-session.test.ts.
 */

function reader(entries: Record<string, unknown>): SettingsLike {
  return {
    getOrThrow: async <T = unknown>(key: string): Promise<T> => {
      if (!(key in entries)) throw new Error(`setting not seeded: ${key}`);
      return entries[key] as T;
    },
  };
}

describe("resolvePositiveInteger", () => {
  it("accepts integer numbers and numeric strings", () => {
    expect(resolvePositiveInteger("k", 5)).toBe(5);
    expect(resolvePositiveInteger("k", "5")).toBe(5);
    expect(resolvePositiveInteger("k", 12, { min: 8 })).toBe(12);
  });

  it("rejects anything that is not a positive integer, loudly", () => {
    for (const bad of [0, -1, 2.5, "x", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolvePositiveInteger("k", bad), String(bad)).toThrow(
        SecuritySettingInvalidError,
      );
    }
  });

  it("enforces min and max, and the message names the key", () => {
    expect(() => resolvePositiveInteger("security.example", 7, { min: 8 })).toThrow(
      /security\.example/,
    );
    expect(() => resolvePositiveInteger("security.example", 9, { max: 8 })).toThrow(
      /security\.example/,
    );
    expect(resolvePositiveInteger("security.example", 8, { min: 8, max: 8 })).toBe(8);
  });
});

describe("settings-backed readers", () => {
  it("read the documented keys as integers and booleans", async () => {
    const settings = reader({
      [SETTING_PASSWORD_MIN_LENGTH]: 12,
      [SETTING_LOGIN_RATE_LIMIT]: 10,
      [SETTING_MASK_SENSITIVE_FIELDS]: true,
    });

    await expect(readPasswordMinLength(settings)).resolves.toBe(12);
    await expect(readLoginMaxFailures(settings)).resolves.toBe(10);
    await expect(readMaskSensitiveFields(settings)).resolves.toBe(true);
  });

  it("floors the password minimum at the §6 value — the setting may only raise it", async () => {
    expect(PASSWORD_MIN_LENGTH_FLOOR).toBe(8);
    await expect(
      readPasswordMinLength(reader({ [SETTING_PASSWORD_MIN_LENGTH]: 4 })),
    ).rejects.toThrow(SecuritySettingInvalidError);
  });

  it("never falls back to a hardcoded number when a key is missing", async () => {
    await expect(readRegisterHourlyLimit(reader({}))).rejects.toThrow(/register_rate_limit/);
    await expect(readPasswordMinLength(reader({}))).rejects.toThrow(/password_min_length/);
    await expect(readLoginMaxFailures(reader({}))).rejects.toThrow(/login_rate_limit/);
    await expect(readMaskSensitiveFields(reader({}))).rejects.toThrow(/mask_sensitive_fields/);
  });
});
