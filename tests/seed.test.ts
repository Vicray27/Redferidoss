import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { derivePublicCode, seedDatabase } from "../prisma/seed";
import { SETTINGS_CATALOG } from "../lib/settings-catalog";

/**
 * Idempotency of the seed without a database.
 *
 * `seedDatabase(client)` takes its Prisma client as a parameter, so a fake that
 * records the SQL it is handed can stand in. This is what pins the spec's
 * "Seed is idempotent — when pnpm seed:root runs twice, the second run
 * succeeds without duplicates" scenario on a machine with no Postgres.
 *
 * The fake does not implement ON CONFLICT; the point of the assertions below
 * is that the seed does not RELY on JavaScript-side dedup: every write is
 * expressed as `ON CONFLICT DO NOTHING` in the statement itself.
 */

interface Recorded {
  kind: "query" | "execute";
  sql: string;
  values: unknown[];
}

class FakePrisma {
  readonly statements: Recorded[] = [];
  rootExists = false;
  /** period_key already present, so the cycle INSERT can return no rows. */
  cycleExists = false;
  settingsSeen = new Map<string, string>();
  methodsSeen = new Set<string>();

  private record(kind: Recorded["kind"]) {
    return (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
      this.statements.push({ kind, sql: strings.join("?"), values });
      return undefined;
    };
  }

  $queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    this.record("query")(strings, ...values);
    const sql = strings.join(" ");

    if (/SELECT id FROM users/.test(sql)) {
      return Promise.resolve(this.rootExists ? [{ id: "root-uuid" }] : []);
    }
    if (/INSERT INTO users/.test(sql)) {
      // A concurrent seed that won the race returns no rows.
      if (this.rootExists) return Promise.resolve([]);
      this.rootExists = true;
      return Promise.resolve([{ id: "root-uuid" }]);
    }
    if (/INSERT INTO payment_cycles/.test(sql)) {
      if (this.cycleExists) return Promise.resolve([]);
      this.cycleExists = true;
      return Promise.resolve([{ id: "cycle-uuid" }]);
    }
    if (/SELECT key, value FROM settings/.test(sql)) {
      return Promise.resolve([
        { key: "general.timezone", value: "America/Caracas" },
        { key: "payments.week_start_day", value: 1 },
        { key: "payments.grace_hours", value: 48 },
        { key: "payments.frequency", value: "WEEKLY" },
      ]);
    }
    return Promise.resolve([]);
  };

  $executeRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
    this.record("execute")(strings, ...values);
    const sql = strings.join(" ");
    const [key] = values as [string];
    if (/INSERT INTO settings/.test(sql)) this.settingsSeen.set(key, String(values[1]));
    if (/INSERT INTO payment_methods/.test(sql)) this.methodsSeen.add(key);
    return Promise.resolve(1);
  };

  $disconnect = (): Promise<void> => Promise.resolve();

  insertsInto(table: string): Recorded[] {
    return this.statements.filter((s) => new RegExp(`INSERT INTO ${table}\\b`).test(s.sql));
  }
}

function withEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const saved = { ...process.env };

describe("prisma/seed.ts — idempotency", () => {
  beforeEach(() => {
    process.env.ROOT_EMAIL = "root@example.com";
    process.env.ROOT_PASSWORD = "a-strong-root-password";
  });

  afterEach(() => {
    withEnv({
      ROOT_EMAIL: saved.ROOT_EMAIL,
      ROOT_PASSWORD: saved.ROOT_PASSWORD,
    });
  });

  it("writes the whole catalog, the base methods and the current cycle", async () => {
    const db = new FakePrisma();
    await seedDatabase(db as never);

    expect(db.insertsInto("users")).toHaveLength(1);
    expect(db.insertsInto("settings")).toHaveLength(SETTINGS_CATALOG.length);
    expect(db.insertsInto("settings")).toHaveLength(40);
    expect(db.insertsInto("payment_methods")).toHaveLength(6);
    expect(db.insertsInto("payment_cycles")).toHaveLength(1);
  });

  it("never lets a duplicate through: every write carries ON CONFLICT DO NOTHING", async () => {
    const db = new FakePrisma();
    await seedDatabase(db as never);

    const inserts = ["users", "settings", "payment_methods", "payment_cycles"].flatMap((table) =>
      db.insertsInto(table),
    );
    expect(inserts.length).toBeGreaterThan(0);

    // `ON CONFLICT DO NOTHING` or `ON CONFLICT (<constraint>) DO NOTHING`.
    const conflictClause = /ON CONFLICT\s*(?:\([^)]*\))?\s+DO NOTHING/;
    for (const statement of inserts) {
      expect(conflictClause.test(statement.sql), statement.sql.slice(0, 60)).toBe(true);
    }
  });

  it("does not insert a second root when one already exists", async () => {
    const db = new FakePrisma();
    db.rootExists = true;

    await seedDatabase(db as never);

    expect(db.insertsInto("users")).toHaveLength(0);
    expect(db.statements.some((s) => /SELECT id FROM users WHERE sponsor_id IS NULL/.test(s.sql))).toBe(true);
    // The catalog is still ensured even when the root predates the seed.
    expect(db.insertsInto("settings")).toHaveLength(40);
  });

  it("survives a second full run without duplicating anything", async () => {
    const db = new FakePrisma();
    await seedDatabase(db as never);
    const firstPass = db.statements.length;

    await seedDatabase(db as never);

    expect(db.rootExists).toBe(true);
    expect(db.insertsInto("users").length).toBe(1); // still only the original insert
    expect(db.settingsSeen.size).toBe(40);
    expect(db.methodsSeen.size).toBe(6);
    // The second pass re-checks the root and re-issues idempotent catalog writes.
    expect(db.statements.length).toBeGreaterThan(firstPass);
  });

  it("lets an existing cycle block the duplicate without an error", async () => {
    const db = new FakePrisma();
    db.cycleExists = true;

    await expect(seedDatabase(db as never)).resolves.toBeUndefined();
  });
});

describe("prisma/seed.ts — credentials", () => {
  beforeEach(() => {
    process.env.ROOT_EMAIL = "root@example.com";
    process.env.ROOT_PASSWORD = "a-strong-root-password";
  });

  afterEach(() => {
    withEnv({
      ROOT_EMAIL: saved.ROOT_EMAIL,
      ROOT_PASSWORD: saved.ROOT_PASSWORD,
    });
  });

  it("refuses to run without ROOT_PASSWORD instead of inventing one", async () => {
    delete process.env.ROOT_PASSWORD;
    const db = new FakePrisma();

    await expect(seedDatabase(db as never)).rejects.toThrow(/ROOT_PASSWORD is required/);
    expect(db.insertsInto("users")).toHaveLength(0);
  });

  it("refuses to run without ROOT_EMAIL", async () => {
    delete process.env.ROOT_EMAIL;
    const db = new FakePrisma();

    await expect(seedDatabase(db as never)).rejects.toThrow(/ROOT_EMAIL is required/);
  });

  it("rejects a blank password the same way as a missing one", async () => {
    process.env.ROOT_PASSWORD = "   ";
    const db = new FakePrisma();

    await expect(seedDatabase(db as never)).rejects.toThrow(/ROOT_PASSWORD is required/);
  });

  it("hashes the password instead of passing the plaintext to the database", async () => {
    process.env.ROOT_PASSWORD = "hunter2-not-in-source";
    const db = new FakePrisma();
    await seedDatabase(db as never);

    const insert = db.insertsInto("users")[0];
    // The clear-text password never reaches a statement, not even as a parameter.
    expect(insert.values).not.toContain("hunter2-not-in-source");
    expect(JSON.stringify(insert.values)).not.toContain("hunter2-not-in-source");

    const hashed = insert.values.find((v) => String(v).startsWith("$argon2id$"));
    expect(hashed, "no Argon2id hash among the INSERT parameters").toBeDefined();
    expect(String(hashed)).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1/);
  });
});

describe("derivePublicCode", () => {
  it("is 8 characters from the unambiguous base32 alphabet", () => {
    expect(derivePublicCode("root@example.com")).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("is stable and case-insensitive on the email", () => {
    expect(derivePublicCode("Root@Example.COM")).toBe(derivePublicCode("root@example.com"));
  });

  it("differs per account", () => {
    expect(derivePublicCode("a@example.com")).not.toBe(derivePublicCode("b@example.com"));
  });
});