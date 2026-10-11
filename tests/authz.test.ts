import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCOPE_ALIAS,
  DOWNLINE_DEPTH_SETTING,
  ForbiddenError,
  createAuthorization,
  isStaffActor,
  narrowDepthCap,
  type RawQueryDb,
  type SessionActor,
  type SettingsLike,
} from "../lib/authz";

/**
 * No database required: `createAuthorization(db, settings)` takes both
 * dependencies, exactly like `createSettingsReader(loader)` (D9) and
 * `createUserRepository(db)` (D14).
 *
 * The point of this file is that §7.1's guarantee stops being a claim. A guard
 * that "should" restrict reads is worth nothing; one whose SQL fragment is
 * captured and asserted — actor id travelling as a bind value, depth cap
 * travelling as a bind value, the alias rejected unless it is an identifier —
 * is worth auditing.
 */

const ROOT_ID = "8f2b5a1e-0000-4000-8000-000000000001";
const MEMBER_ID = "8f2b5a1e-0000-4000-8000-000000000002";
const OTHER_ID = "8f2b5a1e-0000-4000-8000-000000000099";

function actor(overrides: Partial<SessionActor> = {}): SessionActor {
  return { userId: MEMBER_ID, role: "MEMBER", ...overrides };
}

interface CapturedCall {
  sql: string;
  values: unknown[];
}

/** Fake raw client that answers the closure lookup with fixed depths. */
function fakeDb(depths: Record<string, number> = {}) {
  const calls: CapturedCall[] = [];
  const db: RawQueryDb = {
    async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) {
      calls.push({ sql: strings.join("?"), values });
      const [, targetId] = values as [string, string];
      const depth = depths[targetId];
      return (depth === undefined ? [] : [{ depth }]) as T;
    },
  };
  return { db, calls };
}

function fakeSettings(depth: number | string): SettingsLike & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    async getOrThrow<T>(key: string): Promise<T> {
      read.push(key);
      return depth as T;
    },
  };
}

describe("assertCanViewUser — §7.1 verbatim", () => {
  it("ROOT and ADMIN see everything and never query the closure", async () => {
    const { db, calls } = fakeDb();
    const authz = createAuthorization(db, fakeSettings(0));

    await expect(authz.assertCanViewUser(actor({ role: "ROOT" }), OTHER_ID)).resolves.toBeUndefined();
    await expect(authz.assertCanViewUser(actor({ role: "ADMIN" }), OTHER_ID)).resolves.toBeUndefined();

    // Zero queries: staff scope is a return, not a lookup. A closure read here
    // would be a per-row cost on every dashboard query.
    expect(calls).toHaveLength(0);
  });

  it("a MEMBER always sees itself, even with no closure row", async () => {
    const { db } = fakeDb();
    const authz = createAuthorization(db, fakeSettings(2));

    await expect(authz.assertCanViewUser(actor(), MEMBER_ID)).resolves.toBeUndefined();
  });

  it("a MEMBER sees its direct child when the cap is unlimited (0)", async () => {
    const { db } = fakeDb({ [OTHER_ID]: 1 });
    const authz = createAuthorization(db, fakeSettings(0));

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).resolves.toBeUndefined();
  });

  it("a MEMBER sees a level-3 descendant when the cap is 3", async () => {
    const { db } = fakeDb({ [OTHER_ID]: 3 });
    const authz = createAuthorization(db, fakeSettings(3));

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).resolves.toBeUndefined();
  });

  it("refuses a level-4 descendant when the cap is 3", async () => {
    const { db } = fakeDb({ [OTHER_ID]: 4 });
    const authz = createAuthorization(db, fakeSettings(3));

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses anybody outside the subtree — R6: no upline, no sibling branch", async () => {
    const { db } = fakeDb();
    const authz = createAuthorization(db, fakeSettings(0));

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the closure lookup is fully parameterised and casts to uuid", async () => {
    const { db, calls } = fakeDb({ [OTHER_ID]: 1 });
    const authz = createAuthorization(db, fakeSettings(0));

    await authz.assertCanViewUser(actor(), OTHER_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain(MEMBER_ID);
    expect(calls[0].sql).not.toContain(OTHER_ID);
    expect(calls[0].values).toEqual([MEMBER_ID, OTHER_ID]);
    expect(calls[0].sql).toContain("ancestor_id = ?::uuid");
    expect(calls[0].sql).toContain("descendant_id = ?::uuid");
  });

  it("reads the depth cap from the settings table, never from a constant", async () => {
    const settings = fakeSettings(2);
    const authz = createAuthorization(fakeDb({ [OTHER_ID]: 3 }).db, settings);

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).rejects.toBeInstanceOf(ForbiddenError);
    expect(settings.read).toEqual([DOWNLINE_DEPTH_SETTING]);
  });

  it("throws instead of defaulting when the setting row is missing", async () => {
    // getOrThrow rejects — that is the whole point of D9. An absent row must
    // not degrade into "unlimited", which would expose the entire network.
    const authz = createAuthorization(fakeDb().db, {
      async getOrThrow<T>(key: string): Promise<T> {
        throw new Error(`SETTINGS_MISSING: the setting "${key}" does not exist.`);
      },
    });

    await expect(authz.assertCanViewUser(actor(), OTHER_ID)).rejects.toThrow(/SETTINGS_MISSING/);
  });
});

describe("ForbiddenError — no enumeration oracle", () => {
  it("one message for every reason, so refusals cannot be told apart", () => {
    const outside = new ForbiddenError("outside subtree");
    const tooDeep = new ForbiddenError("depth 4 exceeds cap");

    expect(outside.message).toBe(tooDeep.message);
    expect(outside.message).not.toContain("depth");
    expect(outside.message).not.toContain("subtree");
  });

  it("keeps the machine reason out of the message but available to the log", async () => {
    const error = new ForbiddenError("target is outside the actor's subtree");

    expect(error.reason).toBe("target is outside the actor's subtree");
    expect(error.status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("scopeFilter — the mandatory half of §7.1", () => {
  it("returns an empty fragment for staff, so /admin queries stay unfiltered", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(0));

    const scope = await authz.scopeFilter(actor({ role: "ROOT" }));

    expect(scope.unrestricted).toBe(true);
    expect(scope.fragment.strings.join("")).toBe("");
    expect(scope.bindings).toEqual([]);
  });

  it("filters through user_closure for a MEMBER", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(0));

    const scope = await authz.scopeFilter(actor());
    const sql = scope.fragment.strings.join("?");

    expect(scope.unrestricted).toBe(false);
    expect(sql).toContain("FROM user_closure sc");
    expect(sql).toContain("sc.ancestor_id = ?::uuid");
    expect(sql).toContain("sc.descendant_id = n.id");
    expect(scope.bindings).toEqual([MEMBER_ID, 0, 0]);
  });

  it("binds the actor id and the cap; neither is spliced into the statement", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(2));

    const scope = await authz.scopeFilter(actor());
    const sql = scope.fragment.strings.join("?");

    expect(sql).not.toContain(MEMBER_ID);
    expect(sql).not.toContain("2");
    expect(scope.bindings).toEqual([MEMBER_ID, 2, 2]);
    expect(scope.maxDepth).toBe(2);
  });

  it("honours the caller's alias so each query can name its own users table", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(0));

    const scope = await authz.scopeFilter(actor(), { alias: "member" });

    expect(scope.fragment.strings.join("?")).toContain("sc.descendant_id = member.id");
  });

  it("rejects an alias that is not a bare SQL identifier", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(0));

    // The alias is the one identifier in the fragment, so it is the one slot
    // that cannot be a bind parameter. It must never be trusted.
    for (const alias of [
      "n) OR 1=1 --",
      "n; DROP TABLE users",
      "1",
      "",
      "n.id",
      "n id",
    ]) {
      await expect(authz.scopeFilter(actor(), { alias })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("defaults to the documented alias", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(0));

    const scope = await authz.scopeFilter(actor());

    expect(scope.fragment.strings.join("?")).toContain(`sc.descendant_id = ${DEFAULT_SCOPE_ALIAS}.id`);
  });
});

describe("narrowDepthCap — 0 means unlimited, and must never win by arithmetic", () => {
  it("returns 0 only when both sides are unlimited", () => {
    expect(narrowDepthCap(0, 0)).toBe(0);
  });

  it("a configured cap is not overridden by a requested 0", () => {
    // Math.min(0, 3) would be 0, which is §6's "unlimited" — the exact bug the
    // sentinel creates.
    expect(narrowDepthCap(3, 0)).toBe(3);
    expect(narrowDepthCap(0, 3)).toBe(3);
  });

  it("keeps the tighter of the two real caps", () => {
    expect(narrowDepthCap(5, 2)).toBe(2);
    expect(narrowDepthCap(2, 5)).toBe(2);
  });

  it("a caller cannot widen its own visibility by asking for more depth", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(2));

    const scope = await authz.scopeFilter(actor(), { requestedMaxDepth: 50 });

    expect(scope.maxDepth).toBe(2);
  });
});

describe("visibleDownlineDepth", () => {
  it("rejects a negative or non-numeric configuration instead of treating it as unlimited", async () => {
    await expect(
      createAuthorization(fakeDb().db, fakeSettings(-1)).visibleDownlineDepth(),
    ).rejects.toBeInstanceOf(RangeError);

    await expect(
      createAuthorization(fakeDb().db, fakeSettings("muchos")).visibleDownlineDepth(),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("truncates a fractional value rather than letting it through", async () => {
    const authz = createAuthorization(fakeDb().db, fakeSettings(3.9));

    await expect(authz.visibleDownlineDepth()).resolves.toBe(3);
  });
});

describe("isStaffActor", () => {
  it("covers exactly ROOT and ADMIN (§7 matrix)", () => {
    expect(isStaffActor({ userId: ROOT_ID, role: "ROOT" })).toBe(true);
    expect(isStaffActor({ userId: ROOT_ID, role: "ADMIN" })).toBe(true);
    expect(isStaffActor({ userId: ROOT_ID, role: "MEMBER" })).toBe(false);
  });
});
