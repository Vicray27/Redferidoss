// =============================================================================
// lib/security-settings.ts — the `security.*` / sensitive-visibility settings,
// read as truth (§13, §18.3).
//
// §18.3: "Ningún número de negocio en el código: leerlo de settings. Si falta
// una clave, fallar de forma explícita con un mensaje claro." This module owns
// the keys and the ONE validator every numeric security parameter goes
// through, so the four consumers (login throttle, register throttle, password
// minimum, session TTL) cannot disagree about what a valid value is.
//
// It is DELIBERATELY pure: no Prisma, no `pg`, no `node:*` imports. That keeps
// it importable from the Edge runtime (lib/auth/session.ts converts the TTL)
// and testable without a database, and it lets callers pass any reader that
// satisfies `SettingsLike` instead of reaching for the module-level one.
//
// A value that cannot be a positive integer is a MISCONFIGURATION, not a
// reason to fall back to a hardcoded number: the error names the key so the
// operator can fix the row, exactly like `SettingsMissingError` does (D9).
// =============================================================================

import type { SettingsLike } from "./authz";

/** §6 — failed logins allowed per fixed 15-minute window (D18 counts failures). */
export const SETTING_LOGIN_RATE_LIMIT = "security.login_rate_limit_per_15m";

/** §6 — registrations allowed per IP per hour (in-memory throttle, D30). */
export const SETTING_REGISTER_RATE_LIMIT = "security.register_rate_limit_per_hour_per_ip";

/** §6 — minimum password length; the catalog's own floor is 8. */
export const SETTING_PASSWORD_MIN_LENGTH = "security.password_min_length";

/** §6 — session lifetime in hours. D17 caps the EFFECTIVE value (see session.ts). */
export const SETTING_SESSION_TTL_HOURS = "security.session_ttl_hours";

/** §6/§13.8 — mask national id / phone in what is displayed to others. */
export const SETTING_MASK_SENSITIVE_FIELDS = "visibility.mask_sensitive_fields";

/**
 * §6 (`minValue` of `security.password_min_length`): the configured minimum can
 * be raised but never lowered below this floor, and the registration form's
 * client-side schema uses it when no settings read has happened yet.
 */
export const PASSWORD_MIN_LENGTH_FLOOR = 8;

/** Thrown when a security setting exists but cannot be used as configured. */
export class SecuritySettingInvalidError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(
      `SETTINGS_INVALID: the setting "${key}" ${reason}. ` +
        `Fix the row in /admin/settings (or re-seed it with "pnpm seed:root"); ` +
        `the code deliberately does not fall back to a hardcoded business number.`,
    );
    this.name = "SecuritySettingInvalidError";
    this.key = key;
  }
}

export interface PositiveIntegerOptions {
  /** Smallest accepted value, inclusive. Defaults to 1. */
  min?: number;
  /** Largest accepted value. Values above it are NOT clamped here. */
  max?: number;
}

/**
 * Validate a raw settings value as an integer inside [min, max].
 *
 * Prisma returns `INT` settings as JS numbers, but a raw SQL write or a JSON
 * stringified value would arrive as something else; both are accepted when
 * they parse to a real integer, and anything else fails loudly.
 */
export function resolvePositiveInteger(
  key: string,
  raw: unknown,
  options: PositiveIntegerOptions = {},
): number {
  const min = options.min ?? 1;
  const parsed = typeof raw === "number" ? raw : Number(raw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new SecuritySettingInvalidError(key, `must be an integer (got ${JSON.stringify(raw)})`);
  }
  if (parsed < min) {
    throw new SecuritySettingInvalidError(key, `must be at least ${min} (got ${parsed})`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new SecuritySettingInvalidError(key, `must be at most ${options.max} (got ${parsed})`);
  }
  return parsed;
}

/**
 * `security.password_min_length`, floored at the §6 minimum. Missing key ->
 * `SettingsMissingError` from the reader (explicit, by contract).
 */
export async function readPasswordMinLength(reader: SettingsLike): Promise<number> {
  return resolvePositiveInteger(
    SETTING_PASSWORD_MIN_LENGTH,
    await reader.getOrThrow<unknown>(SETTING_PASSWORD_MIN_LENGTH),
    { min: PASSWORD_MIN_LENGTH_FLOOR },
  );
}

/** `security.register_rate_limit_per_hour_per_ip`, for the in-memory throttle. */
export async function readRegisterHourlyLimit(reader: SettingsLike): Promise<number> {
  return resolvePositiveInteger(
    SETTING_REGISTER_RATE_LIMIT,
    await reader.getOrThrow<unknown>(SETTING_REGISTER_RATE_LIMIT),
  );
}

/** `security.login_rate_limit_per_15m`, for the persistent failed-login counter. */
export async function readLoginMaxFailures(reader: SettingsLike): Promise<number> {
  return resolvePositiveInteger(
    SETTING_LOGIN_RATE_LIMIT,
    await reader.getOrThrow<unknown>(SETTING_LOGIN_RATE_LIMIT),
  );
}

/** `visibility.mask_sensitive_fields` as a real boolean. */
export async function readMaskSensitiveFields(reader: SettingsLike): Promise<boolean> {
  return Boolean(await reader.getOrThrow<unknown>(SETTING_MASK_SENSITIVE_FIELDS));
}
