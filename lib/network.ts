// =============================================================================
// lib/network.ts — every §12 read the tree UI needs, under §7.1's two rules.
//
// THE CONTRACT WITH lib/authz.ts
// ------------------------------
// Two things happen on every call, in this order:
//
//   1. `assertCanViewUser(actor, targetId)` — §7.1 verbatim — answers "may this
//      actor see THAT row", and for MEMBER it is what makes a deep node a 403
//      instead of an empty page.
//   2. `scopeFilter(actor)` is ANDed into the statement itself — "ninguna
//      consulta de lectura de red … sin pasar por un scopeFilter (actor)". It
//      is not a post-filter: an out-of-scope row is never SELECTed. This is also
//      what turns a listing into an authorization decision instead of a
//      presentation choice.
//
// FOR MEMBERS, `breadcrumb` IS RELATIVE
// -------------------------------------
// The scope fragment (alias `a`) restricts the ancestor chain to the actor's
// own subtree, so a MEMBER sees "you → … → target". Staff, who are
// unrestricted, get the full chain from the root. Same code path, the scope
// fragment decides.
//
// FOR MEMBERS, COUNTS ARE SCOPED TOO
// ----------------------------------
// `childrenCount` and `subtreeSize` are disclosure like anything else: "3
// people hang below this person" is information about a subtree the caller may
// not read. Under the F4 ceiling (D40) a MEMBER only gets counts for their own
// row, and `subtreeSize` runs under the same scope fragment as every other
// read — so the number only ever counts people the member can actually see.
//
// PAGINATION IS KEYSET, NOT OFFSET
// --------------------------------
// `cursor` is the child's ltree `path` — stable under concurrent inserts, in
// tree order, and already unique. OFFSET would skip or repeat rows whenever a
// sibling appears mid-pagination, which on a referral tree is a normal day.
//
// All statements carry `/* @net:… */` markers for the same reason as the other
// modules: tests route a fake client by intent, not by query text.
// =============================================================================

import { Prisma } from "@prisma/client";

import {
  authorization as defaultAuthorization,
  isStaffActor,
  type Authorization,
  type RawQueryDb,
  type SessionActor,
  type SettingsLike,
} from "./authz";
import { NotFoundError } from "./errors";
import { maskSensitive } from "./mask";
import { readMaskSensitiveFields } from "./security-settings";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;

/** Clamp a client-provided page size into something the DB should serve. */
export function clampLimit(limit: number | undefined, fallback = DEFAULT_PAGE_SIZE): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}

export interface NetworkNode {
  id: string;
  publicCode: string;
  fullName: string;
  status: string;
  depth: number;
  joinedAt: string;
  /** Direct children of the row; forced to 0 for a MEMBER looking at somebody else (D40). */
  childrenCount: number;
  /** Opaque keyset cursor (the node's ltree path). */
  cursor: string;
}

export interface NetworkNodeRef {
  id: string;
  publicCode: string;
  fullName: string;
  depth: number;
}

export interface NetworkNodeDetail extends NetworkNode {
  sponsor: NetworkNodeRef | null;
  /**
   * Email/phone, only for staff or the user themself. A MEMBER browsing their
   * downline sees identity and tree position, not contact data. §13.8: when
   * `visibility.mask_sensitive_fields` is on, the phone is masked for every
   * viewer who is NOT its owner — staff included — at serialization time, so
   * the raw value never leaves the server.
   */
  contact: { email: string | null; phone: string | null } | null;
}

export interface ChildrenPage {
  parentId: string;
  nodes: NetworkNode[];
  nextCursor: string | null;
}

export interface ListChildrenParams {
  parentId?: string;
  cursor?: string | null;
  limit?: number;
}

/** One `custom_field_values` row, labeled for display (jsonb stays raw). */
export interface CustomValue {
  label: string;
  type: string;
  value: unknown;
}

export interface NetworkService {
  listChildren(actor: SessionActor, params?: ListChildrenParams): Promise<ChildrenPage>;
  search(actor: SessionActor, query: string, options?: { limit?: number }): Promise<NetworkNode[]>;
  node(actor: SessionActor, targetId: string): Promise<NetworkNodeDetail>;
  breadcrumb(actor: SessionActor, targetId: string): Promise<NetworkNodeRef[]>;
  /** Live descendants of `targetId` (defaults to the actor's own node). */
  subtreeSize(actor: SessionActor, targetId?: string): Promise<number>;
  /** Custom values of a node; staff or self only, same rule as `contact`. */
  customValues(actor: SessionActor, targetId: string): Promise<CustomValue[]>;
}

interface RawNodeRow {
  id: string;
  publicCode: string;
  fullName: string;
  status: string;
  depth: number;
  joinedAt: Date;
  cursor: string;
  childrenCount: unknown;
}

interface RawDetailRow extends RawNodeRow {
  email: string | null;
  phone: string | null;
  sponsorId: string | null;
}

interface RawCustomValueRow {
  label: string;
  type: string;
  value: unknown;
}

/**
 * D40: a MEMBER only sees the count on their own row. The children of a
 * downline node are exactly the subtree the F4 ceiling hides, so a count there
 * would leak by the number what the listing no longer shows.
 */
function countsVisibleFor(actor: SessionActor, rowId: string): boolean {
  return isStaffActor(actor) || actor.userId === rowId;
}

function toNode(row: RawNodeRow, options: { childrenCountHidden?: boolean } = {}): NetworkNode {
  return {
    id: row.id,
    publicCode: row.publicCode,
    fullName: row.fullName,
    status: row.status,
    depth: row.depth,
    joinedAt: row.joinedAt instanceof Date ? row.joinedAt.toISOString() : String(row.joinedAt),
    childrenCount: options.childrenCountHidden ? 0 : Number(row.childrenCount ?? 0),
    cursor: row.cursor,
  };
}

/**
 * `Prisma.empty` cannot be interpolated as a bare `AND`: `WHERE x AND ` is a
 * syntax error. Staff get no clause at all; everyone else gets the fragment.
 */
function scopeCondition(scope: { fragment: Prisma.Sql; unrestricted: boolean }): Prisma.Sql {
  return scope.unrestricted ? Prisma.empty : Prisma.sql`AND ${scope.fragment}`;
}

export function createNetworkService(
  db: RawQueryDb,
  authz: Authorization = defaultAuthorization,
  settings: SettingsLike,
): NetworkService {
  const listChildren: NetworkService["listChildren"] = async (actor, params = {}) => {
    // Default to the actor's own node: the portal tree starts at "me".
    const parentId = params.parentId ?? actor.userId;
    await authz.assertCanViewUser(actor, parentId);

    const scope = await authz.scopeFilter(actor, { alias: "u" });
    const condition = scopeCondition(scope);
    const limit = clampLimit(params.limit);
    const cursor = params.cursor?.trim() ? params.cursor.trim() : null;

    const rows = await db.$queryRaw<RawNodeRow[]>`
      /* @net:children */
      SELECT
        u.id,
        u.public_code AS "publicCode",
        u.full_name   AS "fullName",
        u.status::text AS status,
        u.depth,
        u.created_at  AS "joinedAt",
        u.path::text  AS cursor,
        (SELECT count(*) FROM users c
          WHERE c.sponsor_id = u.id AND c.deleted_at IS NULL) AS "childrenCount"
      FROM users u
      WHERE u.sponsor_id = ${parentId}::uuid
        AND u.deleted_at IS NULL
        ${condition}
        AND (${cursor}::text IS NULL OR u.path::text > ${cursor})
      ORDER BY u.path
      LIMIT ${limit + 1}
    `;

    // LIMIT n+1: the extra row proves there is a next page without a COUNT.
    const hasMore = rows.length > limit;
    const page = rows
      .slice(0, limit)
      .map((row) => toNode(row, { childrenCountHidden: !countsVisibleFor(actor, row.id) }));
    return {
      parentId,
      nodes: page,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].cursor : null,
    };
  };

  const search: NetworkService["search"] = async (actor, query, options = {}) => {
    const q = query.trim();
    if (q === "") return [];

    const scope = await authz.scopeFilter(actor, { alias: "u" });
    const condition = scopeCondition(scope);
    const limit = clampLimit(options.limit, 20);

    const rows = await db.$queryRaw<RawNodeRow[]>`
      /* @net:search */
      SELECT
        u.id,
        u.public_code AS "publicCode",
        u.full_name   AS "fullName",
        u.status::text AS status,
        u.depth,
        u.created_at  AS "joinedAt",
        u.path::text  AS cursor,
        (SELECT count(*) FROM users c
          WHERE c.sponsor_id = u.id AND c.deleted_at IS NULL) AS "childrenCount"
      FROM users u
      WHERE u.deleted_at IS NULL
        ${condition}
        AND (u.full_name ILIKE '%' || ${q} || '%' OR u.public_code = upper(${q}))
      ORDER BY u.depth, u.full_name
      LIMIT ${limit}
    `;

    return rows.map((row) => toNode(row, { childrenCountHidden: !countsVisibleFor(actor, row.id) }));
  };

  const node: NetworkService["node"] = async (actor, targetId) => {
    await authz.assertCanViewUser(actor, targetId);

    const scope = await authz.scopeFilter(actor, { alias: "u" });
    const condition = scopeCondition(scope);

    const rows = await db.$queryRaw<RawDetailRow[]>`
      /* @net:node */
      SELECT
        u.id,
        u.public_code AS "publicCode",
        u.full_name   AS "fullName",
        u.status::text AS status,
        u.depth,
        u.created_at  AS "joinedAt",
        u.path::text  AS cursor,
        u.email::text AS email,
        u.phone,
        u.sponsor_id::text AS "sponsorId",
        (SELECT count(*) FROM users c
          WHERE c.sponsor_id = u.id AND c.deleted_at IS NULL) AS "childrenCount"
      FROM users u
      WHERE u.id = ${targetId}::uuid
        AND u.deleted_at IS NULL
        ${condition}
    `;

    const row = rows[0];
    // assertCanViewUser already said yes; reaching here without a row means the
    // row was deleted in between (404) — or the scope disagreed (also 404, and
    // deliberately indistinguishable from "does not exist").
    if (!row) throw new NotFoundError();

    let sponsor: NetworkNodeRef | null = null;
    if (row.sponsorId) {
      // Deliberately unfiltered: the sponsor of an in-scope node is the actor,
      // another in-scope node, or — only for the actor's OWN row — the actor's
      // own referrer, whose name the portal shows by design (§12 "Patrocinador").
      const sponsorRows = await db.$queryRaw<NetworkNodeRef[]>`
        /* @net:sponsor */
        SELECT id, public_code AS "publicCode", full_name AS "fullName", depth
        FROM users
        WHERE id = ${row.sponsorId}::uuid AND deleted_at IS NULL
      `;
      sponsor = sponsorRows[0] ?? null;
    }

    const canSeeContact = isStaffActor(actor) || actor.userId === row.id;

    let contact: NetworkNodeDetail["contact"] = null;
    if (canSeeContact) {
      // §13.8: masking protects what OTHERS see — the owner always reads their
      // own record unmasked, and a missing key throws rather than defaulting.
      const isSelf = actor.userId === row.id;
      const mask = !isSelf && (await readMaskSensitiveFields(settings));
      contact = {
        email: row.email,
        phone: mask ? maskSensitive(row.phone) : row.phone,
      };
    }

    return {
      ...toNode(row, { childrenCountHidden: !countsVisibleFor(actor, row.id) }),
      sponsor,
      contact,
    };
  };

  const breadcrumb: NetworkService["breadcrumb"] = async (actor, targetId) => {
    await authz.assertCanViewUser(actor, targetId);

    // Alias `a`: the scope fragment filters the ANCESTORS. For a MEMBER that
    // trims the chain to its own subtree (see the header note); staff keep the
    // full root-to-target chain.
    const scope = await authz.scopeFilter(actor, { alias: "a" });
    const condition = scopeCondition(scope);

    return db.$queryRaw<NetworkNodeRef[]>`
      /* @net:breadcrumb */
      SELECT
        a.id,
        a.public_code AS "publicCode",
        a.full_name   AS "fullName",
        a.depth
      FROM user_closure sc
      JOIN users a ON a.id = sc.ancestor_id
      WHERE sc.descendant_id = ${targetId}::uuid
        AND a.deleted_at IS NULL
        ${condition}
      ORDER BY sc.depth DESC
    `;
  };

  const subtreeSize: NetworkService["subtreeSize"] = async (actor, targetId) => {
    const root = targetId ?? actor.userId;
    await authz.assertCanViewUser(actor, root);

    // The count is a disclosure, so it runs under the same scope fragment as
    // every other read (D40): a MEMBER counts the descendants they may
    // actually see — their direct invitees at most — and a downline node's
    // deeper network counts as 0 instead of leaking its size. Staff are
    // unrestricted and keep the full number.
    const scope = await authz.scopeFilter(actor, { alias: "u" });
    const condition = scopeCondition(scope);

    // `depth > 0` excludes the closure's self row (ancestor = descendant), so
    // the number is "my network", not "my network plus me".
    const rows = await db.$queryRaw<{ total: unknown }[]>`
      /* @net:subtree */
      SELECT count(*)::int AS total
      FROM user_closure c
      JOIN users u ON u.id = c.descendant_id AND u.deleted_at IS NULL
      WHERE c.ancestor_id = ${root}::uuid
        AND c.depth > 0
        ${condition}
    `;

    return Number(rows[0]?.total ?? 0);
  };

  const customValues: NetworkService["customValues"] = async (actor, targetId) => {
    await authz.assertCanViewUser(actor, targetId);

    // Same disclosure rule as `contact`: custom values are profile data and a
    // MEMBER browsing a downline node sees identity and tree position, not the
    // downline's answers to the sponsor's questions.
    if (!isStaffActor(actor) && actor.userId !== targetId) return [];

    const rows = await db.$queryRaw<RawCustomValueRow[]>`
      /* @net:custom-values */
      SELECT d.label, d.type::text AS type, v.value
      FROM custom_field_values v
      JOIN custom_fields d ON d.id = v.field_id
      WHERE v.entity_id = ${targetId}::uuid
        AND d.entity = 'USER'
        AND d.is_active = TRUE
      ORDER BY d.sort_order ASC, d.label ASC
    `;

    return rows.map((row) => ({ label: row.label, type: row.type, value: row.value }));
  };

  return { listChildren, search, node, breadcrumb, subtreeSize, customValues };
}
