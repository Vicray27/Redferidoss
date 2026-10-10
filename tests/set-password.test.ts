import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { setPassword } from "../scripts/set-password";

/**
 * No database: `setPassword` takes the client as a parameter, so a fake can
 * capture the statement and its bind values — the same pattern as
 * tests/seed.test.ts.
 *
 * This script is the only supported way to recover a lost password, so the
 * things that must NOT happen are the things worth testing: no default
 * password, no plaintext reaching the database, no matching on a case-sensitive
 * column, and no UPDATE that could resurrect a deleted account.
 */

interface Recorded {
  sql: string;
  values: unknown[];
}

class FakePrisma {
  statements: Recorded[] = [];
  rows: Array<{ id: string; public_code: string }> = [
    { id: "8f2b5a1e-0000-4000-8000-000000000001", public_code: "JJGYCMQ1" },
  ];

  $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    this.statements.push({ sql: strings.join("?"), values });
    return Promise.resolve(this.rows);
  };

  $disconnect = (): Promise<void> => Promise.resolve();
}

function fakeClient(rows?: Array<{ id: string; public_code: string }>): FakePrisma {
  const fake = new FakePrisma();
  if (rows) fake.rows = rows;
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
  process.env.AUTH_USER_EMAIL = "root@example.com";
  process.env.AUTH_USER_PASSWORD = "a-strong-new-password";
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

  it("refuses to run without an email", async () => {
    delete process.env.AUTH_USER_EMAIL;
    await expect(setPassword(asClient(fakeClient()))).rejects.toThrow(/AUTH_USER_EMAIL/);
  });

  it("never lets the plaintext reach the database", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));

    const [statement] = client.statements;
    expect(statement.sql).not.toContain("a-strong-new-password");
    expect(statement.values.some((v) => v === "a-strong-new-password")).toBe(false);
    // What travels is an Argon2id PHC string, exactly as the seed writes it.
    expect(String(statement.values[0])).toMatch(/^\$argon2id\$/);
  });

  it("reuses lib/password.ts, so the stored parameters cannot drift from the seed", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));
    const hash = String(client.statements[0].values[0]);
    // m=19456,t=2,p=1 is ARGON2_OPTIONS in lib/password.ts.
    expect(hash).toContain("m=19456,t=2,p=1");
  });
});

describe("scripts/set-password.ts — the UPDATE", () => {
  it("parameterises the email with an explicit citext cast", async () => {
    const client = fakeClient();
    await setPassword(asClient(client));

    const [statement] = client.statements;
    expect(statement.sql).toContain("email = ?::citext");
    expect(statement.sql).not.toContain("root@example.com");
    expect(statement.values).toContain("root@example.com");
  });

  it("normalises the email so the lookup is case-insensitive", async () => {
    process.env.AUTH_USER_EMAIL = "  Root@Example.COM  ";
    const client = fakeClient();
    await setPassword(asClient(client));
    expect(client.statements[0].values).toContain("root@example.com");
  });

  it("scopes the UPDATE to live accounts only", async () => {
    // Resetting the password of a soft-deleted user would resurrect access.
    const client = fakeClient();
    await setPassword(asClient(client));
    expect(client.statements[0].sql).toContain("deleted_at IS NULL");
  });

  it("reports a clear error when no account matches, instead of silently succeeding", async () => {
    const client = fakeClient([]);
    await expect(setPassword(asClient(client))).rejects.toThrow(/No user matched/);
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