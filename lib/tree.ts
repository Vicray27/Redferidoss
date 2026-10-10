// =============================================================================
// lib/tree.ts — referral-tree helpers over the triple-redundant model (§4).
//
// The tree is maintained by the database, not by this file:
//   * `users.sponsor_id` is the canonical parent pointer,
//   * `users.path` (ltree) and `users.depth` are written ONLY by
//     fn_user_tree_insert (BEFORE INSERT) and fn_user_move (UPDATE),
//   * `user_closure` is written only by those two functions,
//   * fn_user_tree_guard rejects any UPDATE that touches path/depth/
//     sponsor_id outside a transaction that set `app.tree_maintenance`.
//
// So this module never writes path or depth. It inserts a node and lets the
// trigger derive them, and it moves a subtree by calling fn_user_move, which
// re-validates cycles, depth limit and quota inside one transaction.
//
// Reads need `$queryRaw` because ltree and the closure table are not
// expressible through Prisma Client (Unsupported columns are absent from the
// generated model, and GiST/partial indexes have no query builder support).
//
// The pure helpers (ltreeLabel, derivePath, wouldCreateCycle,
// descendantCountsByLevel) mirror the SQL semantics exactly and are unit
// tested without a database; the async ones wrap the parameterised SQL.
// =============================================================================

import { prisma } from "./db";

/** Root node path, assigned by fn_user_tree_insert when sponsor_id IS NULL. */
export const ROOT_PATH = "root";

/**
 * Mirrors `fn_ltree_label(public_code)` from 0001_init (D2):
 *   'u_' || regexp_replace(lower(code), '[^a-z0-9_]', '_', 'g')
 *
 * The `u_` prefix is what guarantees the ltree "starts with a letter" rule
 * even when the base32 public code starts with a digit, and it can never
 * collide with the `root` label. Keep this in sync with the SQL; the drift
 * test in tests/tree.test.ts pins the shared cases.
 */
export function ltreeLabel(publicCode: string): string {
  return `u_${publicCode.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

/**
 * Mirrors the BEFORE INSERT branch of fn_user_tree_insert: a root gets
 * 'root', a child appends its label to the parent's path.
 *
 * Advisory only — the database is what actually derives the stored value.
 * Used to predict a path before inserting (UI previews, test assertions)
 * and to reason about `<@` subtree queries.
 */
export function derivePath(parentPath: string | null, publicCode: string): string {
  if (parentPath === null) return ROOT_PATH;
  return `${parentPath}.${ltreeLabel(publicCode)}`;
}

/** One row of user_closure: `ancestor_id` is `depth` edges above `descendant_id`. */
export interface ClosureEdge {
  ancestorId: string;
  descendantId: string;
  depth: number;
}

/**
 * Anti-cycle check (R5), same predicate as fn_user_move's `CYCLIC_MOVE`
 * branch: a target that is already inside the moved subtree would close a
 * loop. The self-row (depth 0) makes `move A under A` fail too.
 */
export function wouldCreateCycle(
  closure: readonly ClosureEdge[],
  userId: string,
  candidateSponsorId: string,
): boolean {
  return closure.some(
    (edge) => edge.ancestorId === userId && edge.descendantId === candidateSponsorId,
  );
}

/**
 * Descendants per relative level, straight from the closure table.
 *
 * depth 1 = direct children, depth 2 = grandchildren, and so on; the depth-0
 * self-rows are excluded. `maxDepth = 0` means unlimited.
 */
export function descendantCountsByLevel(
  closure: readonly ClosureEdge[],
  ancestorId: string,
  maxDepth = 0,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const edge of closure) {
    if (edge.ancestorId !== ancestorId) continue;
    if (edge.depth < 1) continue;
    if (maxDepth > 0 && edge.depth > maxDepth) continue;
    counts.set(edge.depth, (counts.get(edge.depth) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0] - b[0]));
}

/** Whole closure subgraph of one node, as stored in user_closure. */
export async function fetchClosure(nodeId: string): Promise<ClosureEdge[]> {
  const rows = await prisma.$queryRaw<ClosureEdge[]>`
    SELECT ancestor_id AS "ancestorId", descendant_id AS "descendantId", depth
    FROM user_closure
    WHERE ancestor_id = ${nodeId}::uuid
  `;
  return rows;
}

export interface NewUserInput {
  publicCode: string;
  sponsorId: string | null;
  email: string;
  passwordHash: string;
  fullName: string;
  role?: "ROOT" | "ADMIN" | "MEMBER";
  status?: "PENDING" | "ACTIVE" | "SUSPENDED";
}

export interface TreeUserRow {
  id: string;
  publicCode: string;
  sponsorId: string | null;
  path: string;
  depth: number;
}

/**
 * Insert a user and let the trigger derive `path`/`depth`/`id`.
 *
 * `path`, `depth` and `id` are NOT in the column list on purpose (D3): the
 * BEFORE INSERT trigger fills them, and any direct write would be rejected by
 * fn_user_tree_guard. `email` is CITEXT, which Prisma cannot type, so the
 * whole insert is raw.
 *
 * R2 (referral quota) is NOT enforced here: per D6 it belongs to the F2
 * SERIALIZABLE registration transaction. The trigger does lock the sponsor row
 * FOR UPDATE, so concurrent inserts under the same parent serialise here.
 */
export async function insertUser(input: NewUserInput): Promise<TreeUserRow> {
  const rows = await prisma.$queryRaw<TreeUserRow[]>`
    INSERT INTO users (public_code, sponsor_id, role, email, password_hash, full_name, status)
    VALUES (
      ${input.publicCode},
      ${input.sponsorId}::uuid,
      ${input.role ?? "MEMBER"}::user_role,
      ${input.email}::citext,
      ${input.passwordHash},
      ${input.fullName},
      ${input.status ?? "ACTIVE"}::user_status
    )
    RETURNING
      id,
      public_code AS "publicCode",
      sponsor_id AS "sponsorId",
      path::text      AS path,
      depth
  `;
  const row = rows[0];
  if (!row) throw new Error("INSERT ... RETURNING returned no row");
  return row;
}

/**
 * Move a whole subtree under a new sponsor (§4.1, §10.5).
 *
 * `fn_user_move` is the only legal rewire: it re-derives path/depth for the
 * subtree, rebuilds the closure links and raises a typed error
 * (SELF_MOVE / ROOT_MOVE_FORBIDDEN / CYCLIC_MOVE / DEPTH_LIMIT_EXCEEDED /
 * REFERRAL_LIMIT_REJECTED) when the move is illegal. It runs in the caller's
 * transaction; wrap it in one if you need the move and its audit row atomic.
 * Historical payment_reports.snapshot_path rows are intentionally untouched.
 */
export async function moveSubtree(userId: string, newSponsorId: string): Promise<void> {
  await prisma.$executeRaw`
    SELECT fn_user_move(${userId}::uuid, ${newSponsorId}::uuid)
  `;
}

/** Direct subtree of a node, using the GiST-backed ltree containment. */
export async function fetchDescendants(rootUserId: string): Promise<TreeUserRow[]> {
  return prisma.$queryRaw<TreeUserRow[]>`
    SELECT
      u.id,
      u.public_code AS "publicCode",
      u.sponsor_id  AS "sponsorId",
      u.path::text  AS path,
      u.depth
    FROM users u
    JOIN users a ON a.id = ${rootUserId}::uuid
    WHERE u.path <@ a.path AND u.id <> a.id AND u.deleted_at IS NULL
    ORDER BY u.path
  `;
}

/** Upline chain, root first. Backed by idx_closure_descendant. */
export async function fetchAncestors(userId: string): Promise<TreeUserRow[]> {
  return prisma.$queryRaw<TreeUserRow[]>`
    SELECT
      u.id,
      u.public_code AS "publicCode",
      u.sponsor_id  AS "sponsorId",
      u.path::text  AS path,
      u.depth
    FROM user_closure c
    JOIN users u ON u.id = c.ancestor_id
    WHERE c.descendant_id = ${userId}::uuid AND c.depth > 0
    ORDER BY c.depth DESC
  `;
}

/** Descendant counts per level for a node, computed in the database. */
export async function countDescendantsByLevel(
  userId: string,
  maxDepth = 0,
): Promise<Map<number, number>> {
  const rows = await prisma.$queryRaw<Array<{ depth: number; total: bigint }>>`
    SELECT c.depth, count(*) AS total
    FROM user_closure c
    WHERE c.ancestor_id = ${userId}::uuid
      AND c.depth > 0
      AND (${maxDepth}::int = 0 OR c.depth <= ${maxDepth}::int)
    GROUP BY c.depth
    ORDER BY c.depth
  `;
  return new Map(rows.map((row) => [row.depth, Number(row.total)]));
}

/**
 * Async pre-check for `moveSubtree`, so the UI can reject a cyclic move with
 * 409 before the transaction runs. fn_user_move still re-checks inside the
 * transaction: this is a UX guard, never the authority.
 */
export async function assertNoCycle(userId: string, newSponsorId: string): Promise<void> {
  const closure = await fetchClosure(userId);
  if (wouldCreateCycle(closure, userId, newSponsorId)) {
    throw new Error("CYCLIC_MOVE: target sponsor is inside the moved subtree");
  }
}

export interface TreeDivergence {
  userId: string;
  publicCode: string;
  reason: string;
}

/**
 * `tree:verify` skeleton (A11/A13): the three redundant structures must agree.
 *
 * Runs the closure-derived depth against the trigger-maintained `depth` and
 * `path`, and returns one divergence per inconsistent row instead of
 * throwing, so the nightly job can report and repair them.
 */
export async function verifyTreeConsistency(): Promise<TreeDivergence[]> {
  return prisma.$queryRaw<TreeDivergence[]>`
    SELECT
      u.id AS "userId",
      u.public_code AS "publicCode",
      concat_ws('; ', remove_nulls(ARRAY[
        CASE WHEN c.depth IS NULL THEN 'missing self row in user_closure' END,
        CASE WHEN c.depth IS NOT NULL AND c.depth <> u.depth
          THEN 'closure depth ' || c.depth || ' <> users.depth ' || u.depth END,
        CASE WHEN c.depth IS NOT NULL AND nlevel(u.path) - 1 <> u.depth
          THEN 'path levels ' || (nlevel(u.path) - 1) || ' <> users.depth ' || u.depth END
      ])) AS reason
    FROM users u
    LEFT JOIN user_closure c
      ON c.descendant_id = u.id AND c.ancestor_id = u.id
    WHERE c.depth IS NULL
       OR c.depth <> u.depth
       OR nlevel(u.path) - 1 <> u.depth
  `;
}