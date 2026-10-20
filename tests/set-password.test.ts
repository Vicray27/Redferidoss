import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { setPassword } from "../scripts/set-password";

/**
 * No database: `setPassword` takes the client as a parameter, so a fake can
 * capture the statements and their bind values — the same pattern as
 * tests/seed.test.ts.
 *
 * This script is the only supported way to recover a lost password, so the
 * things that must NOT happen are the things worth testing: no default
 * password, no plaintext reaching the database, no case-sensitive identifier
 * match, and no UPDATE that could resurrect a deleted account.
 *
 * D86 changed the lookup to `findByIdentifier` (email, cédula or username) and
 * the UPDATE to target the resolved primary key. The fake distinguishes SELECT
 * from UPDATE so those two statements can be asserted independently.
 */

interface Recorded {
  sql: string;
  values: unknown[];
}

class FakePrisma {
  statements: Recorded[] = [];
  selectRows: Array<{ id: string }> = [
    { id: "8f2b5a1e-0000-4000-8000-000000000001" },
  ];
  updateRows: Array<{ public_code: string }> = [{ public_code: "JJGYCMQ1" }];

  $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sql = strings.join("?");
    this.statements.push({ sql, values });
    return Promise.resolve(/^\s*SELECT/i.test(sql) ? this.selectRows : this.updateRows);
  };

  $disconnect = (): Promise<void> => Promise.resolve();
}

function fakeClient(options: { noUser?: boolean } = {}): FakePrisma {
  const fake = new FakePrisma();
  if (options.noUser) fake.selectRows = [];
  return fake;
}

function asClient(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const saved = { ...process.env };

function withEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  withEnv({
    AUTH_USER_IDENTIFIER: "root@example.com",
    AUTH_USER_EMAIL: undefined,
    AUTH_USER_PASSWORD: "a-strong-new-password",
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("scripts/set-password.ts — credentials", () => {
  it("refuses to run without a password instead of inventing one", async () => {
    delete process.env.AUTH_USER_PASSWORD;
    // A generated or committed password would be a permanent backdoor.
    await expect(setPassword(asClient(fakeClient()))).rejects.toThrow(/AUTH_USER_PASSWORD/);
  });

  it("rejects a blank password the same way as a missing one", async () => {
    process.env.AUTH_USER_PASSWORD = "   ";
    await expect(setPassword(asClient(fakeClient()))).rejects.toThrow(/AUTH_USER_PASSWORD/);
  });

  it("refuses to run without an identifier (new or legacy)", async () => {
    delete process.env.AUTH_USER_IDENTIFIER;
    delete process.env.AUTH_USER_EMAIL;
    await expect(setPassword(asClient(fakeClient()))).rejects.toThrow(/AUTH_USER_IDENTIFIER/);
  });

  it("accepts the legacy AUTH_USER_EMAIL when the new name is absent", async () => {
    delete process.env.AUTH_USER_IDENTIFIER;
    process.env.AUTH_USER_EMAIL = "root@example.com";

    const client = fakeClient();
    await setPassword(asClient(client));

    expect(client.statements[0].values).toContain("root@example.com");
  });

  it("prefers AUTH_USER_IDENTIFIER when both names are present", async () => {
    process.env.AUTH_USER_IDENTIFIER = "juan.perez";
    process.env.AUTH_USER_EMAIL = "legacy@example.com";

    const client = fakeClient();
    await setPassword(asClient(client));

    expect(client.statements[0].values).toContain("juan.perez");
    expect(client.statements[0].values).not.toContain("legacy@example.com");
  });

  it("never lets the plaintext reach the database", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));

    for (const statement of client.statements) {
      expect(statement.sql).not.toContain("a-strong-new-password");
      expect(statement.values.some((v) => v === "a-strong-new-password")).toBe(false);
    }
    // What travels is an Argon2id PHC string, exactly as the seed writes it.
    expect(String(client.statements[1].values[0])).toMatch(/^\$argon2id\$/);
  });

  it("reuses lib/password.ts, so the stored parameters cannot drift from the seed", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));
    const hash = String(client.statements[1].values[0]);
    // m=19456,t=2,p=1 is ARGON2_OPTIONS in lib/password.ts.
    expect(hash).toContain("m=19456,t=2,p=1");
  });
});

describe("scripts/set-password.ts — identifier lookup", () => {
  it("looks up all three forms through findByIdentifier", async () => {
    process.env.AUTH_USER_IDENTIFIER = " V-12.345.678 ";
    const client = fakeClient();
    await setPassword(asClient(client));

    const [select] = client.statements;
    expect(select.sql).toContain("email = ?::citext");
    expect(select.sql).toContain("username = ?::citext");
    expect(select.sql).toContain("regexp_replace(national_id");
    expect(select.sql).not.toContain("V-12.345.678");
    expect(select.values[0]).toBe("V-12.345.678");
    expect(select.values[2]).toBe("V-12.345.678");
  });

  it("trims the identifier but leaves case to the CITEXT comparison", async () => {
    process.env.AUTH_USER_IDENTIFIER = "  Root@Example.COM  ";
    const client = fakeClient();
    await setPassword(asClient(client));
    expect(client.statements[0].values[0]).toBe("Root@Example.COM");
  });

  it("scopes the SELECT to live accounts only", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));
    expect(client.statements[0].sql).toContain("deleted_at IS NULL");
  });
});

describe("scripts/set-password.ts — the UPDATE", () => {
  it("updates by the resolved primary key, not by a second identifier match", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));

    const update = client.statements[1];
    expect(update.sql).toContain("WHERE id = ?::uuid");
    expect(update.values[1]).toBe("8f2b5a1e-0000-4000-8000-000000000001");
    expect(update.sql).not.toContain("email =");
  });

  it("scopes the UPDATE to live accounts only", async () => {
    // Resetting the password of a soft-deleted user would resurrect access.
    const client = fakeClient();
    await setPassword(asClient(client));
    expect(client.statements[1].sql).toContain("deleted_at IS NULL");
  });

  it("reports a clear error when no account matches, instead of silently succeeding", async () => {
    const client = fakeClient({ noUser: true });
    await expect(setPassword(asClient(client))).rejects.toThrow(/No user matched/);
    // Nothing is hashed or updated when the lookup fails.
    expect(client.statements).toHaveLength(1);
  });

  it("reports how many accounts were updated", async () => {
    await expect(setPassword(asClient(fakeClient()))).resolves.toBe(1);
  });

  it("warns that already-issued sessions survive the reset", async () => {
    // Stateless JWTs cannot be revoked (D17); the operator has to know that.
    const log = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await setPassword(asClient(fakeClient()));
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toMatch(/8h|stateless/i);
  });
});
