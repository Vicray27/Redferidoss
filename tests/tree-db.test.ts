// =============================================================================
// tests/tree-db.test.ts — async half of lib/tree.ts (F8 WU4 coverage).
//
// tests/tree.test.ts pins the PURE helpers (ltreeLabel, derivePath,
// wouldCreateCycle, descendantCountsByLevel); the functions here are the ones
// that talk to Postgres through `prisma.$queryRaw`/`$executeRaw`, so they are
// exercised with a mocked ./db module. The assertions pin the SQL CONTRACT:
// which table is touched, which parameters travel as values (never
// interpolated), and how rows map back to the TypeScript shapes. The actual
// ltree/closure semantics belong to the triggers and are covered by the seed
// and demo verification probes against a live database.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: db.queryRaw, $executeRaw: db.executeRaw },
}));

import {
  assertNoCycle,
  countDescendantsByLevel,
  fetchAncestors,
  fetchClosure,
  fetchDescendants,
  insertUser,
  moveSubtree,
  type TreeUserRow,
} from "../lib/tree";

/** Joined text of the first template call, so SQL can be asserted by table. */
function sqlOf(call: number): string {
  return (db.queryRaw.mock.calls[call]?.[0] as TemplateStringsArray).join("?");
}

function valuesOf(call: number): unknown[] {
  return db.queryRaw.mock.calls[call]?.slice(1) ?? [];
}

beforeEach(() => {
  db.queryRaw.mockReset();
  db.executeRaw.mockReset();
});

describe("fetchClosure", () => {
  it("reads the closure rows for one ancestor and returns them untouched", async () => {
    const rows = [
      { ancestorId: "a", descendantId: "a", depth: 0 },
      { ancestorId: "a", descendantId: "b", depth: 1 },
    ];
    db.queryRaw.mockResolvedValueOnce(rows);

    await expect(fetchClosure("a")).resolves.toBe(rows);
    expect(sqlOf(0)).toContain("FROM user_closure");
    expect(sqlOf(0)).toContain("ancestor_id =");
    expect(valuesOf(0)).toEqual(["a"]);
  });
});

describe("insertUser", () => {
  const row: TreeUserRow = {
    id: "u-1",
    publicCode: "ABC123",
    sponsorId: "p-1",
    path: "root.u_p1.u_abc123",
    depth: 2,
  };

  it("inserts without path/depth (the trigger derives them) and returns the row", async () => {
    db.queryRaw.mockResolvedValueOnce([row]);

    await expect(
      insertUser({
        publicCode: "ABC123",
        sponsorId: "p-1",
        email: "a@b.com",
        passwordHash: "phc",
        fullName: "Ana",
      }),
    ).resolves.toBe(row);

    const sql = sqlOf(0);
    expect(sql).toContain(
      "INSERT INTO users (public_code, sponsor_id, role, email, password_hash, full_name, status)",
    );
    expect(sql).toContain("RETURNING");
  });

  it("defaults role to MEMBER and status to ACTIVE when omitted", async () => {
    db.queryRaw.mockResolvedValueOnce([row]);

    await insertUser({
      publicCode: "ABC123",
      sponsorId: null,
      email: "a@b.com",
      passwordHash: "phc",
      fullName: "Ana",
    });

    const values = valuesOf(0);
    expect(values[2]).toBe("MEMBER");
    expect(values[6]).toBe("ACTIVE");
    // A root travels as a null sponsor, not as the string "null".
    expect(values[1]).toBeNull();
  });

  it("passes explicit role and status through", async () => {
    db.queryRaw.mockResolvedValueOnce([row]);

    await insertUser({
      publicCode: "ABC123",
      sponsorId: "p-1",
      email: "a@b.com",
      passwordHash: "phc",
      fullName: "Ana",
      role: "ADMIN",
      status: "PENDING",
    });

    const values = valuesOf(0);
    expect(values[2]).toBe("ADMIN");
    expect(values[6]).toBe("PENDING");
  });

  it("fails loudly when RETURNING comes back empty", async () => {
    db.queryRaw.mockResolvedValueOnce([]);

    await expect(
      insertUser({
        publicCode: "ABC123",
        sponsorId: null,
        email: "a@b.com",
        passwordHash: "phc",
        fullName: "Ana",
      }),
    ).rejects.toThrow(/INSERT \.\.\. RETURNING returned no row/);
  });
});

describe("moveSubtree", () => {
  it("calls fn_user_move with both ids as parameters (the only legal rewire)", async () => {
    db.executeRaw.mockResolvedValueOnce(1);

    await expect(moveSubtree("u-1", "s-1")).resolves.toBeUndefined();

    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("fn_user_move");
    expect(values).toEqual(["u-1", "s-1"]);
  });
});

describe("fetchDescendants", () => {
  it("uses ltree containment (<@) and excludes the node itself and soft-deleted rows", async () => {
    const rows: TreeUserRow[] = [];
    db.queryRaw.mockResolvedValueOnce(rows);

    await expect(fetchDescendants("root-1")).resolves.toBe(rows);

    const sql = sqlOf(0);
    expect(sql).toContain("u.path <@ a.path");
    expect(sql).toContain("u.id <> a.id");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("ORDER BY u.path");
    expect(valuesOf(0)).toEqual(["root-1"]);
  });
});

describe("fetchAncestors", () => {
  it("walks user_closure upwards, deepest first, skipping the self-row", async () => {
    const rows: TreeUserRow[] = [];
    db.queryRaw.mockResolvedValueOnce(rows);

    await expect(fetchAncestors("u-9")).resolves.toBe(rows);

    const sql = sqlOf(0);
    expect(sql).toContain("FROM user_closure c");
    expect(sql).toContain("c.descendant_id =");
    expect(sql).toContain("c.depth > 0");
    expect(sql).toContain("ORDER BY c.depth DESC");
    expect(valuesOf(0)).toEqual(["u-9"]);
  });
});

describe("countDescendantsByLevel", () => {
  it("converts bigint totals to numbers and keeps depth order", async () => {
    db.queryRaw.mockResolvedValueOnce([
      { depth: 1, total: 12n },
      { depth: 2, total: 144n },
      { depth: 3, total: 0n },
    ]);

    const counts = await countDescendantsByLevel("u-1");

    expect([...counts.entries()]).toEqual([
      [1, 12],
      [2, 144],
      [3, 0],
    ]);
  });

  it("passes maxDepth through (0 means unlimited) and filters in SQL", async () => {
    db.queryRaw.mockResolvedValueOnce([]);

    await countDescendantsByLevel("u-1", 2);

    const sql = sqlOf(0);
    expect(sql).toContain("GROUP BY c.depth");
    expect(sql).toContain("c.depth <= ");
    // maxDepth travels twice: once for the "0 means unlimited" check, once for
    // the filter itself.
    expect(valuesOf(0)).toEqual(["u-1", 2, 2]);
  });

  it("defaults maxDepth to 0", async () => {
    db.queryRaw.mockResolvedValueOnce([]);

    await countDescendantsByLevel("u-1");

    expect(valuesOf(0)).toEqual(["u-1", 0, 0]);
  });
});

describe("assertNoCycle", () => {
  it("resolves when the target sponsor is outside the moved subtree", async () => {
    db.queryRaw.mockResolvedValueOnce([
      { ancestorId: "u-1", descendantId: "u-2", depth: 1 },
    ]);

    await expect(assertNoCycle("u-1", "outside")).resolves.toBeUndefined();
  });

  it("rejects with CYCLIC_MOVE when the target is inside the subtree", async () => {
    db.queryRaw.mockResolvedValueOnce([
      { ancestorId: "u-1", descendantId: "inside", depth: 2 },
    ]);

    await expect(assertNoCycle("u-1", "inside")).rejects.toThrow(/CYCLIC_MOVE/);
  });

  it("rejects a self-move through the depth-0 self-row", async () => {
    db.queryRaw.mockResolvedValueOnce([
      { ancestorId: "u-1", descendantId: "u-1", depth: 0 },
    ]);

    await expect(assertNoCycle("u-1", "u-1")).rejects.toThrow(/CYCLIC_MOVE/);
  });
});
