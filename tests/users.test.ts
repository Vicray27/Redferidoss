import { describe, expect, it } from "vitest";

import {
  createUserRepository,
  normalizeEmail,
  normalizePublicCode,
  type AuthUserRow,
  type ProfileUserRow,
  type RawQueryDb,
} from "../lib/users";

/**
 * No database required: `createUserRepository` takes the raw-query client as a
 * parameter (same pattern as `createSettingsReader(loader)`, D9), so these
 * tests can assert the exact SQL template and the bind values that reach it.
 *
 * That is the point of this file. "We use $queryRaw so it is parameterised" is
 * a claim; capturing the template and proving the email arrives as a bind
 * parameter (and never spliced into the SQL text) is a test.
 */

interface CapturedCall {
  sql: string;
  values: unknown[];
}

/** Records every $queryRaw invocation and returns the rows the test wants. */
function fakeDb<T>(rows: T[] = []) {
  const calls: CapturedCall[] = [];
  const db: RawQueryDb = {
    async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) {
      calls.push({ sql: strings.join("?"), values });
      return rows as T;
    },
  };
  return { db, calls };
}

const ROOT_ROW: AuthUserRow = {
  id: "8f2b5a1e-0000-4000-8000-000000000001",
  publicCode: "JJGYCMQ1",
  email: "victorjoseraymond@gmail.com",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb",
  fullName: "Administrador ROOT",
  role: "ROOT",
  status: "ACTIVE",
};

describe("normalizeEmail", () => {
  it("folds case and trims, so the same address has one canonical form", () => {
    expect(normalizeEmail("  VictorJoseRaymond@Gmail.COM ")).toBe("victorjoseraymond@gmail.com");
    expect(normalizeEmail("VICTORJOSERAYMOND@GMAIL.COM")).toBe(
      normalizeEmail("victorjoseraymond@gmail.com"),
    );
  });

  it("uses locale-independent lowercasing (Turkish dotless-i safety)", () => {
    // toLocaleLowerCase() under tr maps "I" to "ı", which would lock out a
    // user whose address contains "I" on a tr-locale host. Pin the behaviour.
    expect(normalizeEmail("INDUSTRIA@EXAMPLE.COM")).toBe("industria@example.com");
    expect(normalizeEmail("İstanbul@example.com")).toBe(
      "i̇stanbul@example.com",
    );
  });

  it("is idempotent, because callers may normalise twice", () => {
    const once = normalizeEmail(" Root@Example.com ");
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe("normalizePublicCode", () => {
  it("upper-cases, because public_code is case-SENSITIVE text", () => {
    expect(normalizePublicCode(" jjgycmq1 ")).toBe("JJGYCMQ1");
    expect(normalizePublicCode("JJGYCMQ1")).toBe("JJGYCMQ1");
  });

  it("is idempotent", () => {
    const once = normalizePublicCode("jjgycmq1");
    expect(normalizePublicCode(once)).toBe(once);
  });
});

describe("findByEmail — the CITEXT workaround", () => {
  it("passes the normalised email as a BIND PARAMETER, never as SQL text", async () => {
    const { db, calls } = fakeDb<AuthUserRow>([ROOT_ROW]);
    await createUserRepository(db).findByEmail("  VictorJose@Gmail.com  ");

    expect(calls).toHaveLength(1);
    const [call] = calls;

    // The user's address must NOT appear anywhere in the statement text.
    expect(call.sql).not.toContain("VictorJose");
    expect(call.sql).not.toContain("gmail");
    // It arrives as a parameter...
    expect(call.values).toEqual(["victorjose@gmail.com"]);
    // ...positioned where the cast is, so Postgres compares CITEXT to CITEXT.
    expect(call.sql).toContain("email = ?::citext");
  });

  it("compares against a CITEXT column, preserving case-insensitive uniqueness", async () => {
    const { db, calls } = fakeDb<AuthUserRow>();
    await createUserRepository(db).findByEmail("root@example.com");

    // Switching this to ::text would silently drop the CITEXT semantics that
    // uq_users_email depends on. Pin it.
    expect(calls[0].sql).toContain("::citext");
  });

  it("excludes soft-deleted users so they are indistinguishable from absent ones", async () => {
    const { db, calls } = fakeDb<AuthUserRow>();
    await createUserRepository(db).findByEmail("root@example.com");
    expect(calls[0].sql).toContain("deleted_at IS NULL");
  });

  it("returns the row when one matches", async () => {
    const { db } = fakeDb<AuthUserRow>([ROOT_ROW]);
    await expect(createUserRepository(db).findByEmail("root@example.com")).resolves.toEqual(
      ROOT_ROW,
    );
  });

  it("returns null when the database returns no rows", async () => {
    const { db } = fakeDb<AuthUserRow>([]);
    await expect(createUserRepository(db).findByEmail("nobody@example.com")).resolves.toBeNull();
  });

  it("SELECTS only the columns it needs, and the password hash only here", async () => {
    const { db, calls } = fakeDb<AuthUserRow>();
    const repo = createUserRepository(db);

    await repo.findByEmail("root@example.com");
    await repo.findByPublicCode("JJGYCMQ1");

    expect(calls[0].sql).toContain('password_hash AS "passwordHash"');
    // The display lookup must not be able to leak a hash by accident.
    expect(calls[1].sql).not.toContain("password_hash");
    expect(calls[1].sql).not.toContain("email");
  });
});

describe("findByPublicCode", () => {
  it("parameterises the code and normalises it to uppercase", async () => {
    const { db, calls } = fakeDb<ProfileUserRow>();
    await createUserRepository(db).findByPublicCode(" jjgycmq1 ");

    expect(calls[0].sql).not.toContain("JJGYCMQ1");
    expect(calls[0].values).toEqual(["JJGYCMQ1"]);
    expect(calls[0].sql).toContain("public_code = ?");
  });

  it("excludes soft-deleted users", async () => {
    const { db, calls } = fakeDb<ProfileUserRow>();
    await createUserRepository(db).findByPublicCode("JJGYCMQ1");
    expect(calls[0].sql).toContain("deleted_at IS NULL");
  });
});