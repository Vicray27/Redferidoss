import { describe, expect, it } from "vitest";

import {
  createLoginRateLimiter,
  loginRateLimitKey,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  RATE_LIMITED_MESSAGE,
  windowStart,
  type RawQueryDb,
} from "../lib/auth/rate-limit";

/**
 * No database: the limiter takes the raw-query client, the clock and the window
 * length as parameters, so the counting behaviour and the SQL shape are both
 * assertable here.
 *
 * The SQL shape matters as much as the arithmetic: a non-atomic
 * read-then-write would let concurrent attempts both read 7 and both store 7,
 * so the suite pins the ON CONFLICT upsert.
 */

interface Captured {
  sql: string;
  values: unknown[];
}

function fakeDb(rows: Array<{ count: number }> = []) {
  const calls: Captured[] = [];
  const db: RawQueryDb = {
    async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) {
      calls.push({ sql: strings.join("?"), values });
      return rows as T;
    },
  };
  return { db, calls };
}

const T0 = 1_800_000_000_000;

describe("loginRateLimitKey", () => {
  it("is stable, and folds case and whitespace so one address is one bucket", () => {
    expect(loginRateLimitKey("Root@Example.com")).toBe(loginRateLimitKey("  root@example.COM "));
  });

  it("does not store the address: the key is a SHA-256 prefix", () => {
    const key = loginRateLimitKey("victorjoseraymond@gmail.com");
    expect(key).toMatch(/^login:[0-9a-f]{32}$/);
    // rate_limits has no owner semantics; storing a plaintext address there
    // would be collecting PII for no benefit.
    expect(key).not.toContain("gmail");
    expect(key).not.toContain("victor");
  });

  it("gives different addresses different keys", () => {
    expect(loginRateLimitKey("a@example.com")).not.toBe(loginRateLimitKey("b@example.com"));
  });
});

describe("windowStart", () => {
  it("buckets times onto a fixed grid, so a retry cannot start a new window", () => {
    const base = windowStart(T0).getTime();
    expect(windowStart(T0 + 1).getTime()).toBe(base);
    expect(windowStart(T0 + LOGIN_WINDOW_MS - 1).getTime()).toBe(base);
    expect(windowStart(T0 + LOGIN_WINDOW_MS).getTime()).toBe(base + LOGIN_WINDOW_MS);
  });
});

describe("current", () => {
  it("returns 0 when the table has no row for this window", async () => {
    const { db } = fakeDb([]);
    await expect(createLoginRateLimiter(db).current("a@example.com")).resolves.toBe(0);
  });

  it("converts the bigint count Postgres returns for a bigint column", async () => {
    const { db } = fakeDb([{ count: BigInt(3) } as unknown as { count: number }]);
    await expect(createLoginRateLimiter(db).current("a@example.com")).resolves.toBe(3);
  });

  it("scopes the read to this window and to the hashed key", async () => {
    const { db, calls } = fakeDb([]);
    await createLoginRateLimiter(db, { now: () => T0 }).current("Root@Example.com");

    const [call] = calls;
    expect(call.sql).toContain("FROM rate_limits");
    expect(call.sql).toContain("WHERE key = ? AND window_start = ?");
    expect(call.values[0]).toBe(loginRateLimitKey("root@example.com"));
    expect(call.values[0]).not.toContain("Root@Example.com");
    expect((call.values[1] as Date).getTime()).toBe(windowStart(T0).getTime());
  });
});

describe("recordFailure", () => {
  it("increments atomically with an upsert", async () => {
    // Read-then-write would let two concurrent attempts both read 7 and store
    // 7, so a burst would slip past the limit.
    const { db, calls } = fakeDb([{ count: 4 }]);
    await createLoginRateLimiter(db).recordFailure("a@example.com");

    const [call] = calls;
    expect(call.sql).toContain("INSERT INTO rate_limits");
    expect(call.sql).toContain(
      "ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1",
    );
    expect(call.sql).toContain("RETURNING count");
    // The two variable parts are parameters; the seed count is a constant, so
    // it belongs in the statement text rather than travelling as a bind.
    expect(call.values).toHaveLength(2);
    expect(call.values[0]).toBe(loginRateLimitKey("a@example.com"));
    expect(call.sql).toMatch(/VALUES \(\?, \?, 1\)/);
  });

  it("returns the new count", async () => {
    const { db } = fakeDb([{ count: 9 }]);
    await expect(createLoginRateLimiter(db).recordFailure("a@example.com")).resolves.toBe(9);
  });
});

describe("reset", () => {
  it("deletes only the current window, leaving older ones to the cleanup job", async () => {
    const { db, calls } = fakeDb([]);
    await createLoginRateLimiter(db, { now: () => T0 }).reset("a@example.com");

    const [call] = calls;
    expect(call.sql).toContain("DELETE FROM rate_limits");
    expect(call.sql).toContain("WHERE key = ? AND window_start = ?");
    expect(call.values[0]).toBe(loginRateLimitKey("a@example.com"));
  });
});

describe("the limit itself", () => {
  it("is 8 failures per 15 minutes, and the message reveals nothing about accounts", async () => {
    expect(LOGIN_MAX_FAILURES).toBe(8);
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
    // The throttle must not become the enumeration oracle that
    // INVALID_CREDENTIALS_MESSAGE refuses to be.
    expect(RATE_LIMITED_MESSAGE).not.toMatch(/contraseña incorrecta|correo|contraseña/i);
  });

  it("is reached at exactly the configured number of failures", async () => {
    const { db } = fakeDb([{ count: LOGIN_MAX_FAILURES }]);
    const limiter = createLoginRateLimiter(db);
    expect(await limiter.current("a@example.com")).toBeGreaterThanOrEqual(LOGIN_MAX_FAILURES);
  });
});