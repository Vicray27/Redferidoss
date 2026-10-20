// =============================================================================
// lib/users.ts — user lookups, including the CITEXT problem (F2 auth).
//
// THE BUG THIS FILE EXISTS TO SOLVE
// --------------------------------
// `users.email` and `users.username` are CITEXT. prisma/schema.prisma declares
// them as `Unsupported("citext")`, and Prisma Client EXCLUDES Unsupported
// fields from the generated model, so there is no `email`/`username` on
// `prisma.user`. Therefore:
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
// D86 extends the lookup: one identifier field matches email, username OR the
// normalised national id. The single query returns at most two rows, and the
// caller receives `null` when TWO DISTINCT users match — ambiguity must never
// resolve silently to whichever row Postgres happened to return first.
//
// Do NOT "simplify" this file into Prisma calls. `lib/tree.ts#insertUser` and
// `prisma/seed.ts` are raw for the same reason.
//
// Every statement below is a tagged template, so every value reaches Postgres
// as a bind parameter. The only literals interpolated into the SQL text are
// constant columns and SQL expressions with no user input in them.
// `tests/users.test.ts` asserts exactly that: it captures the template and its
// bind values and proves the identifier travels as a parameter.
//
// Normalisation is applied in BOTH places on purpose:
//   * in the app (lib/identity.ts) so the behaviour is unit-testable without
//     a database and so every caller agrees on what "the same identifier" means;
//   * in the database (`::citext` and the normalised national-id expression) so
//     comparisons stay case-insensitive even if a caller forgets to normalise.
// =============================================================================

import { prisma } from "./db";
import { normalizeEmail, normalizeNationalId } from "./identity";

export { normalizeEmail } from "./identity";

/** The `user_role` enum, narrowed for app use. Mirrors 0001_init. */
export type UserRole = "ROOT" | "ADMIN" | "MEMBER";

/** The `user_status` enum, narrowed for app use. Mirrors 0001_init. */
export type UserStatus = "PENDING" | "ACTIVE" | "SUSPENDED";

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
  /** Cast to text server-side; the JS side sees an ordinary string or null. */
  email: string | null;
  /** Stored lower-case; null for every legacy user (no backfill). */
  username: string | null;
  /** Stored as entered; compared through the normalised expression. */
  nationalId: string | null;
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
   * Kept for callers that genuinely know they hold an email (and for the
   * compatibility path of `scripts/set-password.ts`). The login form uses
   * `findByIdentifier` instead.
   *
   * Soft-deleted rows are excluded here rather than by the caller: a deleted
   * user must be indistinguishable from a non-existent one, so the login form
   * cannot be used to enumerate deleted accounts.
   */
  findByEmail(email: string): Promise<AuthUserRow | null>;
  /**
   * Credential lookup by email, username or national id (D86).
   *
   * One parameterised statement covers all three, so the login path has one
   * query to audit. `LIMIT 2` is deliberate: two distinct matches mean the
   * identifier is ambiguous, and the caller gets `null` rather than a silently
   * chosen account.
   */
  findByIdentifier(identifier: string): Promise<AuthUserRow | null>;
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
          username::text AS username,
          national_id   AS "nationalId",
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

    async findByIdentifier(identifier: string): Promise<AuthUserRow | null> {
      const trimmed = identifier.trim();
      const nationalId = normalizeNationalId(trimmed);
      const rows = await db.$queryRaw<AuthUserRow[]>`
        SELECT
          id,
          public_code   AS "publicCode",
          email::text   AS email,
          username::text AS username,
          national_id   AS "nationalId",
          password_hash AS "passwordHash",
          full_name     AS "fullName",
          role::text    AS role,
          status::text  AS status
        FROM users
        WHERE deleted_at IS NULL
          AND (
            email = ${trimmed}::citext
            OR username = ${trimmed}::citext
            OR upper(regexp_replace(national_id, '\\s+', '', 'g')) = ${nationalId}
          )
        LIMIT 2
      `;
      // Two rows means an email, username or national id of one account matched
      // a different account's value. There is no safe winner: refuse both.
      if (rows.length > 1) return null;
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