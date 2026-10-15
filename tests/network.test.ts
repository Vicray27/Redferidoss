// =============================================================================
// tests/network.test.ts — §7.1/R6 enforcement in every §12 read.
//
// The authorization service under test is the REAL `createAuthorization`:
// the point of these tests is that the scope fragment is actually ANDed into
// the statements, and that a MEMBER's queries come out depth-capped. A fake
// that answered "authorized" would prove neither.
// =============================================================================

import { describe, expect, it } from "vitest";

import { ForbiddenError, createAuthorization, type RawQueryDb } from "../lib/authz";
import { NotFoundError } from "../lib/errors";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampLimit,
  createNetworkService,
} from "../lib/network";
import type { SettingsLike } from "../lib/authz";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (values: unknown[]) => unknown;

/** Duck-typed `Prisma.Sql` (the real instances carry `sql` + `values`). */
function isSqlLike(value: unknown): value is { sql: string; values: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { sql?: unknown; values?: unknown };
  return typeof candidate.sql === "string" && Array.isArray(candidate.values);
}

class NetFake implements RawQueryDb {
  readonly calls: Array<{ marker: string; values: unknown[] }> = [];
  /** Depth rows the authz closure lookup answers with. */
  closureRows: Array<{ depth: number }> = [];
  private readonly handlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.handlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.calls.filter((call) => call.marker === marker);
  }

  /** The non-empty scope fragment embedded in a call, if any. */
  scopeFragmentOf(marker: string): { sql: string; values: unknown[] } | null {
    for (const call of this.callsFor(marker)) {
      for (const value of call.values) {
        if (isSqlLike(value) && value.sql.trim() !== "") return value;
      }
    }
    return null;
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* (@net:[\w-]+) \*\//.exec(text)?.[1];

    if (!marker) {
      // The authz layer's own statements (assertCanViewUser) carry no marker.
      if (text.includes("user_closure") && text.includes("SELECT depth")) {
        return this.closureRows as T;
      }
      throw new Error(`NetFake: unmarked statement: ${text}`);
    }

    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`NetFake: no handler for ${marker}`);
    this.calls.push({ marker, values });
    return (await handler(values)) as T;
  }
}

function fakeSettings(entries: Record<string, unknown>): SettingsLike {
  return {
    getOrThrow: async <T = unknown>(key: string): Promise<T> => {
      if (!(key in entries)) throw new Error(`setting not seeded in fake: ${key}`);
      return entries[key] as T;
    },
  };
}

const MEMBER = { userId: "member-1", role: "MEMBER" as const };
const ROOT = { userId: "root-1", role: "ROOT" as const };

function makeService(fake: NetFake, depthVisible = 3) {
  const authz = createAuthorization(
    fake,
    fakeSettings({ "visibility.downline_depth_visible": depthVisible }),
  );
  return { authz, network: createNetworkService(fake, authz) };
}

const CHILD_ROW = {
  id: "child-1",
  publicCode: "CHILD001",
  fullName: "Hijo Uno",
  status: "ACTIVE",
  depth: 1,
  joinedAt: new Date("2026-09-01T12:00:00Z"),
  cursor: "root.member-1.child-1",
  childrenCount: BigInt(2),
};

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe("clampLimit", () => {
  it("defaults, floors at 1 and caps at the maximum", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10_000)).toBe(MAX_PAGE_SIZE);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });
});

// ---------------------------------------------------------------------------
// listChildren
// ---------------------------------------------------------------------------

describe("listChildren — the scope fragment goes into the SQL (§7.1)", () => {
  it("embeds the member's scope fragment with the actor id and the F4 cap", async () => {
    const fake = new NetFake().on("@net:children", () => [CHILD_ROW]);
    const { network } = makeService(fake);

    const page = await network.listChildren(MEMBER);

    expect(page.parentId).toBe("member-1");
    expect(page.nodes).toEqual([
      {
        id: "child-1",
        publicCode: "CHILD001",
        fullName: "Hijo Uno",
        status: "ACTIVE",
        depth: 1,
        joinedAt: "2026-09-01T12:00:00.000Z",
        // D40: the downline node's count is not the member's to see.
        childrenCount: 0,
        cursor: "root.member-1.child-1",
      },
    ]);

    const fragment = fake.scopeFragmentOf("@net:children");
    expect(fragment).not.toBeNull();
    expect(fragment?.sql).toContain("EXISTS");
    // Configured 3 is narrowed to the member ceiling of 1 (D40).
    expect(fragment?.values).toEqual(["member-1", 1, 1]);
  });

  it("adds no clause for staff", async () => {
    const fake = new NetFake().on("@net:children", () => []);
    const { network } = makeService(fake);

    await network.listChildren(ROOT);

    expect(fake.scopeFragmentOf("@net:children")).toBeNull();
  });

  it("refuses a parent outside the member's subtree before any listing (R6)", async () => {
    const fake = new NetFake().on("@net:children", () => [CHILD_ROW]);
    fake.closureRows = []; // no closure row: not a descendant
    const { network } = makeService(fake);

    await expect(network.listChildren(MEMBER, { parentId: "stranger-9" })).rejects.toMatchObject({
      name: "ForbiddenError",
      status: 403,
      code: "FORBIDDEN",
    });
    expect(fake.callsFor("@net:children")).toHaveLength(0);
  });

  it("refuses a parent beyond the visible depth", async () => {
    const fake = new NetFake().on("@net:children", () => []);
    fake.closureRows = [{ depth: 9 }]; // deeper than the F4 member ceiling (D40)
    const { network } = makeService(fake);

    await expect(network.listChildren(MEMBER, { parentId: "deep-9" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("paginates by keyset: n+1 rows mean a next page", async () => {
    const rows = [
      { ...CHILD_ROW, id: "c1", cursor: "root.member-1.c1" },
      { ...CHILD_ROW, id: "c2", cursor: "root.member-1.c2" },
      { ...CHILD_ROW, id: "c3", cursor: "root.member-1.c3" },
    ];
    const fake = new NetFake().on("@net:children", () => rows);
    const { network } = makeService(fake);

    const page = await network.listChildren(MEMBER, { limit: 2 });

    expect(page.nodes.map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(page.nextCursor).toBe("root.member-1.c2");
    // The statement asked for limit+1 — the probe row.
    const limitBinding = fake.callsFor("@net:children")[0].values.at(-1);
    expect(limitBinding).toBe(3);
  });

  it("returns no cursor when the page is the last one", async () => {
    const fake = new NetFake().on("@net:children", () => [CHILD_ROW]);
    const { network } = makeService(fake);

    const page = await network.listChildren(MEMBER, { limit: 5 });
    expect(page.nodes).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("search", () => {
  it("returns [] for an empty query without touching the database", async () => {
    const fake = new NetFake();
    const { network } = makeService(fake);

    expect(await network.search(MEMBER, "   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("scopes the search to the member's subtree", async () => {
    const fake = new NetFake().on("@net:search", () => [CHILD_ROW]);
    const { network } = makeService(fake);

    const hits = await network.search(MEMBER, "hijo");

    expect(hits).toHaveLength(1);
    const fragment = fake.scopeFragmentOf("@net:search");
    expect(fragment?.values).toEqual(["member-1", 1, 1]);
  });

  it("hides the count on others but keeps it on the member's own row (D40)", async () => {
    const selfRow = { ...CHILD_ROW, id: "member-1", childrenCount: BigInt(5) };
    const fake = new NetFake().on("@net:search", () => [selfRow, CHILD_ROW]);
    const { network } = makeService(fake);

    const hits = await network.search(MEMBER, "hijo");

    expect(hits.map((node) => node.childrenCount)).toEqual([5, 0]);
  });

  it("passes the raw term as a bind parameter, never into SQL text", async () => {
    const fake = new NetFake().on("@net:search", () => []);
    const { network } = makeService(fake);

    await network.search(ROOT, "o'brien; DROP TABLE users");

    const values = fake.callsFor("@net:search")[0]?.values ?? [];
    expect(values).toContain("o'brien; DROP TABLE users");
  });
});

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

describe("node — detail with contact rules", () => {
  const DETAIL_ROW = { ...CHILD_ROW, email: "hijo@example.com", phone: "+595 981 000 000", sponsorId: "member-1" };
  const SPONSOR_REF = { id: "member-1", publicCode: "PARENT01", fullName: "Mamá", depth: 0 };

  it("shows contact data to staff", async () => {
    const fake = new NetFake()
      .on("@net:node", () => [DETAIL_ROW])
      .on("@net:sponsor", () => [SPONSOR_REF]);
    const { network } = makeService(fake);

    const detail = await network.node(ROOT, "child-1");

    expect(detail.contact).toEqual({ email: "hijo@example.com", phone: "+595 981 000 000" });
    expect(detail.sponsor).toEqual(SPONSOR_REF);
    expect(detail.childrenCount).toBe(2);
  });

  it("hides contact data and the downline count from a member browsing a downline node", async () => {
    const fake = new NetFake()
      .on("@net:node", () => [DETAIL_ROW])
      .on("@net:sponsor", () => [SPONSOR_REF]);
    fake.closureRows = [{ depth: 1 }];
    const { network } = makeService(fake);

    const detail = await network.node(MEMBER, "child-1");
    expect(detail.contact).toBeNull();
    expect(detail.childrenCount).toBe(0);
  });

  it("shows contact data to the member on their own row", async () => {
    const selfRow = { ...DETAIL_ROW, id: "member-1", sponsorId: "root-1" };
    const fake = new NetFake()
      .on("@net:node", () => [selfRow])
      .on("@net:sponsor", () => [{ id: "root-1", publicCode: "ROOT0001", fullName: "Raíz", depth: 0 }]);
    const { network } = makeService(fake);

    const detail = await network.node(MEMBER, "member-1");
    expect(detail.contact).toEqual({ email: "hijo@example.com", phone: "+595 981 000 000" });
    // The D40 count rule has an exception: you always see your own count.
    expect(detail.childrenCount).toBe(2);
  });

  it("404s when the scoped statement selects nothing", async () => {
    const fake = new NetFake().on("@net:node", () => []);
    fake.closureRows = [{ depth: 1 }];
    const { network } = makeService(fake);

    await expect(network.node(MEMBER, "child-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not query a sponsor for a root-level node", async () => {
    const rootRow = { ...DETAIL_ROW, sponsorId: null };
    const fake = new NetFake().on("@net:node", () => [rootRow]);
    const { network } = makeService(fake);

    const detail = await network.node(ROOT, "child-1");
    expect(detail.sponsor).toBeNull();
    expect(fake.callsFor("@net:sponsor")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// breadcrumb
// ---------------------------------------------------------------------------

describe("breadcrumb — same code path, the scope fragment decides", () => {
  const FULL_CHAIN = [
    { id: "root-1", publicCode: "ROOT0001", fullName: "Raíz", depth: 0 },
    { id: "member-1", publicCode: "PARENT01", fullName: "Mamá", depth: 1 },
    { id: "child-1", publicCode: "CHILD001", fullName: "Hijo Uno", depth: 2 },
  ];

  it("trims the member's chain to the F4 ceiling (D40)", async () => {
    // The real scoped statement never returns root-1 for a member — it sits at
    // depth 2 from them and the fragment filters it out; the fake serves the
    // rows the scoped SQL would.
    const memberChain = FULL_CHAIN.slice(1);
    const fake = new NetFake().on("@net:breadcrumb", () => memberChain);
    fake.closureRows = [{ depth: 1 }];
    const { network } = makeService(fake);

    const chain = await network.breadcrumb(MEMBER, "child-1");
    expect(chain.map((n) => n.id)).toEqual(["member-1", "child-1"]);

    const fragment = fake.scopeFragmentOf("@net:breadcrumb");
    expect(fragment?.sql).toContain("sc.descendant_id = a.id");
    expect(fragment?.values).toEqual(["member-1", 1, 1]);
  });

  it("gives staff the full chain with no fragment", async () => {
    const fake = new NetFake().on("@net:breadcrumb", () => FULL_CHAIN);
    const { network } = makeService(fake);

    const chain = await network.breadcrumb(ROOT, "child-1");
    expect(chain.map((n) => n.id)).toEqual(["root-1", "member-1", "child-1"]);
    expect(fake.scopeFragmentOf("@net:breadcrumb")).toBeNull();
  });

  it("refuses ids outside the member's subtree", async () => {
    const fake = new NetFake().on("@net:breadcrumb", () => FULL_CHAIN);
    fake.closureRows = [];
    const { network } = makeService(fake);

    await expect(network.breadcrumb(MEMBER, "stranger-9")).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.callsFor("@net:breadcrumb")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// subtreeSize and customValues — the detail-page extras
// ---------------------------------------------------------------------------

describe("subtreeSize", () => {
  it("counts the member's network under the scope fragment (D40)", async () => {
    const fake = new NetFake().on("@net:subtree", () => [{ total: BigInt(7) }]);
    const { network } = makeService(fake);

    expect(await network.subtreeSize(MEMBER)).toBe(7);
    expect(fake.callsFor("@net:subtree")[0].values).toContain("member-1");
    // The count itself is disclosure: it only counts rows the member may see.
    const fragment = fake.scopeFragmentOf("@net:subtree");
    expect(fragment?.values).toEqual(["member-1", 1, 1]);
  });

  it("counts without a fragment for staff", async () => {
    const fake = new NetFake().on("@net:subtree", () => [{ total: BigInt(7) }]);
    const { network } = makeService(fake);

    expect(await network.subtreeSize(ROOT, "member-1")).toBe(7);
    expect(fake.scopeFragmentOf("@net:subtree")).toBeNull();
  });

  it("returns 0 rather than NaN for a missing row", async () => {
    const fake = new NetFake().on("@net:subtree", () => []);
    const { network } = makeService(fake);

    expect(await network.subtreeSize(MEMBER)).toBe(0);
  });

  it("refuses an explicit target outside the member's subtree before counting", async () => {
    const fake = new NetFake().on("@net:subtree", () => [{ total: 1 }]);
    fake.closureRows = [];
    const { network } = makeService(fake);

    await expect(network.subtreeSize(MEMBER, "stranger-9")).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.callsFor("@net:subtree")).toHaveLength(0);
  });
});

describe("customValues — the same disclosure rule as contact", () => {
  const ROWS = [
    { label: "Ciudad de nacimiento", type: "TEXT", value: "Asunción" },
    { label: "Acepta términos", type: "BOOL", value: true },
  ];

  it("returns values for the member's own row", async () => {
    const fake = new NetFake().on("@net:custom-values", () => ROWS);
    const { network } = makeService(fake);

    const values = await network.customValues(MEMBER, "member-1");
    expect(values).toEqual(ROWS);
    expect(fake.callsFor("@net:custom-values")[0].values).toContain("member-1");
  });

  it("returns values for staff (same rule as contact data)", async () => {
    const fake = new NetFake().on("@net:custom-values", () => ROWS);
    const { network } = makeService(fake);

    expect(await network.customValues(ROOT, "child-1")).toEqual(ROWS);
  });

  it("returns [] for a member browsing a downline node, without querying", async () => {
    const fake = new NetFake();
    fake.closureRows = [{ depth: 1 }];
    const { network } = makeService(fake);

    expect(await network.customValues(MEMBER, "child-1")).toEqual([]);
    expect(fake.callsFor("@net:custom-values")).toHaveLength(0);
  });

  it("refuses ids outside the member's subtree before deciding on disclosure", async () => {
    const fake = new NetFake().on("@net:custom-values", () => ROWS);
    fake.closureRows = [];
    const { network } = makeService(fake);

    await expect(network.customValues(MEMBER, "stranger-9")).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.callsFor("@net:custom-values")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The invariant: no read without the fragment
// ---------------------------------------------------------------------------

describe("invariant — every network read carries a scope decision (§7.1)", () => {
  it("each statement either has a non-empty fragment or ran for staff", async () => {
    const fake = new NetFake()
      .on("@net:children", () => [])
      .on("@net:search", () => [])
      .on("@net:node", () => [{ ...CHILD_ROW, email: null, phone: null, sponsorId: null }])
      .on("@net:sponsor", () => [])
      .on("@net:breadcrumb", () => [])
      .on("@net:subtree", () => [{ total: 0 }]);
    fake.closureRows = [{ depth: 1 }];
    const { network } = makeService(fake);

    await network.listChildren(MEMBER, { parentId: "child-1" });
    await network.search(MEMBER, "x");
    await network.node(MEMBER, "child-1");
    await network.breadcrumb(MEMBER, "child-1");
    await network.subtreeSize(MEMBER);

    const scopedMarkers = [
      "@net:children",
      "@net:search",
      "@net:node",
      "@net:breadcrumb",
      "@net:subtree",
    ];
    for (const marker of scopedMarkers) {
      expect(fake.scopeFragmentOf(marker), `${marker} missing scope fragment`).not.toBeNull();
    }
  });
});
