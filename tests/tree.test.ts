import { describe, expect, it } from "vitest";

import {
  derivePath,
  descendantCountsByLevel,
  ltreeLabel,
  ROOT_PATH,
  wouldCreateCycle,
  type ClosureEdge,
} from "../lib/tree";

/**
 * Pure parts of lib/tree.ts, verified without a database. They exist as
 * separate functions precisely so the ltree/closure semantics that the SQL
 * triggers enforce can be asserted here — the SQL side needs a live Postgres,
 * which this repository does not have (no docker daemon by design).
 *
 * The label cases mirror `fn_ltree_label` in 0001_init. If one side changes,
 * these tests are where the mirror is noticed.
 */

describe("ltreeLabel (mirrors fn_ltree_label, D2)", () => {
  it("prefixes u_ so a base32 code starting with a digit is still a valid label", () => {
    expect(ltreeLabel("7KQ2M9XZ")).toBe("u_7kq2m9xz");
  });

  it("lowercases the code", () => {
    expect(ltreeLabel("ABCDEF")).toBe("u_abcdef");
  });

  it("replaces every character outside [a-z0-9_] with an underscore", () => {
    expect(ltreeLabel("ab-cd")).toBe("u_ab_cd");
    expect(ltreeLabel("a b")).toBe("u_a_b");
    expect(ltreeLabel("user@example.com")).toBe("u_user_example_com");
  });

  it("always produces a label that starts with a letter", () => {
    for (const code of ["1", "0abc", "9z", "-x"]) {
      expect(ltreeLabel(code)[0], code).toMatch(/[a-z]/);
    }
  });

  it("never collides with the root label", () => {
    expect(ltreeLabel("root")).not.toBe(ROOT_PATH);
    expect(ROOT_PATH).toBe("root");
  });

  it("keeps underscores that are already in the code", () => {
    expect(ltreeLabel("a_b")).toBe("u_a_b");
  });

  it("handles an empty code without throwing (degenerate, but must not crash)", () => {
    expect(ltreeLabel("")).toBe("u_");
  });
});

describe("derivePath", () => {
  it("gives the root the bare 'root' path when there is no sponsor", () => {
    expect(derivePath(null, "ABC123")).toBe("root");
  });

  it("appends the label to the parent path", () => {
    expect(derivePath("root", "ABC123")).toBe("root.u_abc123");
    expect(derivePath("root.u_abc123", "XYZ789")).toBe("root.u_abc123.u_xyz789");
  });

  it("keeps depth in step with the number of labels after 'root'", () => {
    // The root's own public code never appears in the path: a root with no
    // sponsor is exactly 'root', which is what the SQL trigger writes.
    const path = derivePath(derivePath(derivePath("root", "AAA"), "BBB"), "CCC");
    expect(path).toBe("root.u_aaa.u_bbb.u_ccc");
    expect(path.split(".").length - 1).toBe(3); // nlevel - 1 == users.depth
  });

  it("never emits an empty label, which would be an invalid ltree", () => {
    expect(derivePath("root", "---").split(".").every((l) => l.length > 0)).toBe(true);
  });
});

/**
 * Fixture closure for:  root -> a -> b -> c
 *                            \-> d
 * Closure rows carry every (ancestor, descendant, distance) pair.
 */
function fixture(): ClosureEdge[] {
  const edge = (ancestorId: string, descendantId: string, depth: number): ClosureEdge => ({
    ancestorId,
    descendantId,
    depth,
  });
  return [
    edge("root", "root", 0),
    edge("a", "a", 0),
    edge("b", "b", 0),
    edge("c", "c", 0),
    edge("d", "d", 0),
    edge("root", "a", 1),
    edge("a", "b", 1),
    edge("b", "c", 1),
    edge("a", "d", 1),
    edge("root", "b", 2),
    edge("a", "c", 2),
    edge("root", "c", 3),
  ];
}

describe("wouldCreateCycle (mirrors the CYCLIC_MOVE branch, R5)", () => {
  const closure = fixture();

  it("rejects moving a node under its own descendant", () => {
    expect(wouldCreateCycle(closure, "a", "b")).toBe(true);
    expect(wouldCreateCycle(closure, "a", "c")).toBe(true);
    expect(wouldCreateCycle(closure, "root", "a")).toBe(true);
  });

  it("rejects moving a node under itself", () => {
    expect(wouldCreateCycle(closure, "a", "a")).toBe(true);
  });

  it("allows moving a node under an ancestor or a sibling branch", () => {
    expect(wouldCreateCycle(closure, "b", "a")).toBe(false);
    expect(wouldCreateCycle(closure, "c", "root")).toBe(false);
    expect(wouldCreateCycle(closure, "c", "d")).toBe(false);
  });

  it("returns false for an unrelated node with no closure row (nothing to prove)", () => {
    expect(wouldCreateCycle(closure, "c", "unknown-id")).toBe(false);
  });
});

describe("descendantCountsByLevel", () => {
  const closure = fixture();

  it("counts direct children at level 1 and excludes the self row", () => {
    expect([...descendantCountsByLevel(closure, "a")]).toEqual([
      [1, 2], // b, d
      [2, 1], // c
    ]);
  });

  it("counts the whole subtree from the root", () => {
    expect([...descendantCountsByLevel(closure, "root")]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  it("returns an empty map for a leaf", () => {
    expect(descendantCountsByLevel(closure, "c").size).toBe(0);
  });

  it("applies maxDepth as an inclusive upper bound", () => {
    expect([...descendantCountsByLevel(closure, "root", 2)]).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("treats maxDepth = 0 as unlimited", () => {
    expect(descendantCountsByLevel(closure, "root", 0).size).toBe(
      descendantCountsByLevel(closure, "root").size,
    );
  });

  it("returns levels in ascending order", () => {
    const levels = [...descendantCountsByLevel(closure, "root").keys()];
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});