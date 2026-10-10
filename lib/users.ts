// =============================================================================
// lib/users.ts — user lookups, including the CITEXT problem (F2 auth).
//
// THE BUG THIS FILE EXISTS TO SOLVE
// --------------------------------
// `users.email` is CITEXT. prisma/schema.prisma declares it as
// `Unsupported("citext")`, and Prisma Client EXCLUDES Unsupported fields from
// the generated model, so there is no `email` on `prisma.user`. Therefore:
//   * `prisma.user.findUnique({ where: { email } })`  -> does not compile;
//   * `prisma.user.create({ data: { email } })`      -> does not compile.
// Both are impossible, not merely awkward.
//
// D14 decides the resolution: keep CITEXT (it is what makes `uq_users_email`
// case-insensitive at the database level) and route every read of the column
// through PARAMETERISED `$queryRaw` with an explicit `::citext` cast. The
// rejected alternative was a mirrored `String @db.Text` field: that trades a
// known inconvenience for a silent bug, because Prisma would then type the
// column as `text` and the case-insensitive comparison would stop being
// enforced anywhere.
//
// Do NOT "simplify" this file into Prisma calls. `lib/tree.ts#insertUser` and
// `prisma/seed.ts` are raw for the same reason.
//
// Every statement below is a tagged template, so every value reaches Postgres
// as a bind parameter. The only literals interpolated into the SQL text are
// the two column lists in this file, which are constants with no user input in
// them. `tests/users.test.ts` asserts exactly that: it captures the template
// and its bind values and proves the email travels as a parameter.
//
// Normalisation is applied in BOTH places on purpose:
//   * in the app (`normalizeEmail`) so the behaviour is unit-testable without
//     a database and so every caller agrees on what "the same address" means;
//   * in the database (`::citext`) so the comparison stays case-insensitive
//     even if a future caller forgets to normalise.
// =============================================================================

import { prisma } from "./db";

/** The `user_role` enum, narrowed for app use. Mirrors 0001_init. */
export type UserRole = "ROOT" | "ADMIN" | "MEMBER";

/** The `user_status` enum, narrowed for app use. Mirrors 0001_init. */
export type UserStatus = "PENDING" | "ACTIVE" | "SUSPENDED";

/**
 * Canonical form of an email for comparison.
 *
 * Uses `toLowerCase()`, NOT `toLocaleLowerCase()`. This is not pedantry: under
 * a Turkish locale `toLocaleLowerCase()` maps "I" to the dotless "ı", so a user
 * whose address contains "I" could never log in on a host whose default locale
 * is `tr`. The comparison the database performs is locale-independent, so the
 * app-side copy has to be too.
 *
 * `citext` performs the same folding internally; this function exists so the
 * normalisation is testable without a database.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Canonical form of a `public_code`.
 *
 * Codes are generated in uppercase Crockford base32 (`derivePublicCode` in
 * prisma/seed.ts, D11), so pasting `jjgycmq1` must still resolve to
 * `JJGYCMQ1`. The column is TEXT with a plain UNIQUE constraint, which is
 * case-SENSITIVE — without this the lookup would silently miss.
 */
export function normalizePublicCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * A user row as the login path needs it, INCLUDING the password hash.
 *
 * Deliberately a separate type from `ProfileUserRow`: the hash must never be
 * reachable from a page, a server component or an API response by accident.
 * Only `findByEmail` returns this shape, and its only caller is the
 * credential check.
 */
export interface AuthUserRow {
  id: string;
  publicCode: string;
  /** Cast to text server-side; the JS side sees an ordinary string. */
  email: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
}

/** A user row for display. Never carries the password hash. */
export interface ProfileUserRow {
  id: string;
  publicCode: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
}

/**
 * The slice of Prisma's client this module needs.
 *
 * Declaring it as a structural type is what lets `tests/users.test.ts` inject a
 * fake that records the SQL template and its bind values, turning "fully
 * parameterised, CITEXT-cast" from a claim into an assertion. Same pattern as
 * `createSettingsReader(loader)` in lib/settings.ts (D9).
 */
export type RawQueryDb = {
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

export interface UserRepository {
  /**
   * Credential lookup by email, case-insensitive.
   *
   * Soft-deleted rows are excluded here rather than by the caller: a deleted
   * user must be indistinguishable from a non-existent one, so the login form
   * cannot be used to enumerate deleted accounts.
   */
  findByEmail(email: string): Promise<AuthUserRow | null>;
  /** Lookup by the human-readable handle used in `/r/{public_code}`. */
  findByPublicCode(publicCode: string): Promise<ProfileUserRow | null>;
}

/** Build a repository over any raw-query client (Prisma in production). */
export function createUserRepository(db: RawQueryDb): UserRepository {
  return {
    async findByEmail(email: string): Promise<AuthUserRow | null> {
      const rows = await db.$queryRaw<AuthUserRow[]>`
        SELECT
          id,
          public_code   AS "publicCode",
          email::text   AS email,
          password_hash AS "passwordHash",
          full_name     AS "fullName",
          role::text    AS role,
          status::text  AS status
        FROM users
        WHERE email = ${normalizeEmail(email)}::citext
          AND deleted_at IS NULL
        LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async findByPublicCode(publicCode: string): Promise<ProfileUserRow | null> {
      const rows = await db.$queryRaw<ProfileUserRow[]>`
        SELECT
          id,
          public_code AS "publicCode",
          full_name   AS "fullName",
          role::text  AS role,
          status::text AS status
        FROM users
        WHERE public_code = ${normalizePublicCode(publicCode)}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      return rows[0] ?? null;
    },
  };
}

/** Process-wide repository used by application code. */
export const users: UserRepository = createUserRepository(prisma);