// =============================================================================
// lib/identity.ts — canonical forms for the three login identifiers.
//
// The product accepts one field that may be an email, a national id (cédula)
// or a username. Each has a different canonical form:
//
//   * email      -> trim + lower-case (CITEXT compares case-insensitively);
//   * username   -> trim + lower-case (the database CHECK only allows lower);
//   * national id -> trim, remove internal whitespace, upper-case, keeping
//                    letters and hyphens so "v 12.345-6" and "V12.345-6" meet.
//
// This module is intentionally dependency-free: it is imported by the client
// registration schema, the server registration service, the login repository
// and the rate limiter. Keeping Prisma out of it prevents a client bundle from
// pulling the database client in through a normalisation helper.
// =============================================================================

/** Lower-case vocabulary accepted by the database CHECK on users.username. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

/** Handles that would look official inside the app. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "root",
  "superadmin",
  "sistema",
  "soporte",
  "api",
  "www",
]);

/** Messages shared by the client schema and the server-side registration. */
export const USERNAME_REQUIRED_MESSAGE = "El usuario es obligatorio.";
export const USERNAME_FORMAT_MESSAGE =
  "El usuario debe tener entre 3 y 30 caracteres: minúsculas, números, punto, guion o guion bajo.";
export const USERNAME_RESERVED_MESSAGE = "Ese usuario no está disponible.";
export const NATIONAL_ID_REQUIRED_MESSAGE = "La cédula es obligatoria.";
export const NATIONAL_ID_TOO_LONG_MESSAGE = "La cédula es demasiado larga.";

/**
 * Canonical form of an email for comparison.
 *
 * Uses `toLowerCase()`, NOT `toLocaleLowerCase()`. Under a Turkish locale the
 * latter maps "I" to the dotless "ı", so an address containing "I" could never
 * log in on a host whose default locale is `tr`. The database's CITEXT folding
 * is locale-independent, so the app-side copy must be too.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Canonical username: the app writes only lower-case, trimmed handles. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Canonical national id.
 *
 * Trims, removes internal whitespace and upper-cases, while preserving hyphens
 * and letters ("V-12.345.678"). The same transformation runs in SQL through
 * `upper(regexp_replace(national_id, '\s+', '', 'g'))`, so the pre-check and
 * the stored representation agree.
 */
export function normalizeNationalId(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

/**
 * Canonical form used only for the login throttle key.
 *
 * Email/username are case-insensitive by CITEXT; national ids are normalised
 * by the SQL expression above. Uppercasing non-email identifiers makes
 * "Juan.Perez" and "juan.perez" share one bucket without changing what the
 * query receives.
 */
export function normalizeLoginIdentifier(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.includes("@") ? normalizeEmail(trimmed) : normalizeNationalId(trimmed);
}

/** True when `value` is a legal username after normalisation. */
export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

/** True when `value` is one of the reserved handles (case-insensitive). */
export function isReservedUsername(value: string): boolean {
  return RESERVED_USERNAMES.has(normalizeUsername(value));
}
