// =============================================================================
// lib/authz.ts — the authorization guard every network read must pass through
// (§7.1, R6, acceptance A4).
//
// Spec §7.1 gives `assertCanViewUser` verbatim; this file implements it as
// written and adds the second half of the rule that follows it: "ninguna
// consulta de lectura de red o pagos se ejecuta sin pasar por un scopeFilter
// (actor)". A guard that only answers "may this actor see THAT row" is not
// enough, because a listing query can silently omit it — so both halves exist
// here and every network query in lib/network.ts takes the second one.
//
// THREE THINGS THIS MODULE DELIBERATELY DOES NOT DO
//
// 1. It does not filter in the client. `scopeFilter` returns a SQL fragment that
//    goes into the WHERE clause of the statement the database executes. The
//    §7.1 "prohibido filtrar en el cliente" rule means a row that is out of
//    scope is never SELECTed at all, not that it is SELECTed and then hidden.
//
// 2. It does not leak WHY access was refused. `ForbiddenError` carries a
//    `reason` for the log and the tests; `message` is a single generic sentence,
//    so a probe cannot tell "not your downline" from "too deep" and walk the
//    tree by watching which ids get refused.
//
// 3. It does not default a missing setting to "unlimited". `visibility.
//    downline_depth_visible` is read with getOrThrow: a database that was never
//    seeded fails loudly instead of quietly exposing the whole network.
//
// Dependencies are injected (`createAuthorization(db, settings)`), the same
// pattern as lib/users.ts and lib/settings.ts, so the whole guard is testable
// without a database and the SQL it builds is assertable.
// =============================================================================

import { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { settings as processSettings, type SettingsReader } from "./settings";
import type { SessionPayload } from "./auth/session";
import type { UserRole } from "./users";

/** §6 key that caps how far down a MEMBER may look. 0 = unlimited. */
export const DOWNLINE_DEPTH_SETTING = "visibility.downline_depth_visible";

/**
 * Default alias of the `users` row a scoped query filters.
 *
 * It is an IDENTIFIER, so it cannot be a bind parameter and must be validated
 * rather than trusted: `scopeFilter` accepts an alias so each query can name its
 * own table, and an unchecked value there would be a SQL injection hole with a
 * very short path. Anything that is not a bare SQL identifier is rejected.
 */
export const DEFAULT_SCOPE_ALIAS = "n";

const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The minimum a caller must be. `SessionPayload` from lib/auth/session.ts
 * satisfies it structurally, so a real session can be passed straight in —
 * which matters, because a wrapper type would create a place where a hand-built
 * `{ role: "ROOT" }` could slip past the check.
 */
export interface SessionActor {
  readonly userId: string;
  readonly role: UserRole;
}

/** §7 matrix: ROOT and ADMIN reach the whole tree; MEMBER reaches its subtree. */
export function isStaffActor(actor: SessionActor): boolean {
  return actor.role === "ROOT" || actor.role === "ADMIN";
}

/**
 * 403. One message for every reason.
 *
 * `reason` is for the operator log and the test assertions; `message` is what a
 * user sees. Keeping them apart is what stops the guard from becoming an
 * enumeration oracle: "you cannot see this person" and "they are too deep in
 * your network" must be indistinguishable from outside.
 */
export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  readonly status = 403;
  readonly reason: string;

  constructor(reason: string) {
    super("No tienes permiso para ver esta información.");
    this.name = "ForbiddenError";
    this.reason = reason;
  }
}

/** Minimal raw-query client, same structural type as lib/users.ts. */
export type RawQueryDb = {
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

/** How deep a MEMBER is allowed to look, from the §6 settings table. */
export type SettingsLike = Pick<SettingsReader, "getOrThrow">;

export interface Authorization {
  /** §7.1, verbatim. Throws `ForbiddenError`, never returns a boolean. */
  assertCanViewUser(actor: SessionActor, targetId: string): Promise<void>;
  /** §7.1's second half: the WHERE fragment every network read must AND in. */
  scopeFilter(actor: SessionActor, options?: ScopeOptions): Promise<NetworkScope>;
  /** The configured downline cap. 0 = unlimited. */
  visibleDownlineDepth(): Promise<number>;
}

export interface ScopeOptions {
  /** Identifier of the `users` alias being filtered. Defaults to `n`. */
  alias?: string;
  /**
   * A cap the CALLER asks for (e.g. `?maxDepth=3`). It can only tighten the
   * configured cap, never loosen it: the tighter of the two wins, and 0 (the
   * "unlimited" sentinel) never overrides a real limit.
   */
  requestedMaxDepth?: number;
}

export interface NetworkScope {
  /** AND this into the WHERE clause of the statement the database runs. */
  fragment: Prisma.Sql;
  /** The values bound inside `fragment`, in order. Asserted by the tests. */
  bindings: readonly unknown[];
  /** True for ROOT/ADMIN: the fragment is `Prisma.empty` and filters nothing. */
  unrestricted: boolean;
  /** Effective cap in force, 0 = unlimited. Meaningless when unrestricted. */
  maxDepth: number;
}

export const UNRESTRICTED_SCOPE: NetworkScope = {
  fragment: Prisma.empty,
  bindings: [],
  unrestricted: true,
  maxDepth: 0,
};

/**
 * Combine the configured cap with a requested one.
 *
 * 0 is §6's "unlimited" sentinel, so it must not win against a real limit by
 * arithmetic — `Math.min(0, 3)` would return 0 and hand the caller the entire
 * tree. Each side is "meaningful" only when it is greater than zero.
 */
export function narrowDepthCap(configured: number, requested: number): number {
  const left = Number.isFinite(configured) && configured > 0 ? configured : 0;
  const right = Number.isFinite(requested) && requested > 0 ? requested : 0;
  if (left === 0) return right;
  if (right === 0) return left;
  return Math.min(left, right);
}

export function createAuthorization(db: RawQueryDb, settings: SettingsLike): Authorization {
  const visibleDownlineDepth = async (): Promise<number> => {
    const value = await settings.getOrThrow<number>(DOWNLINE_DEPTH_SETTING);
    const depth = Number(value);
    if (!Number.isFinite(depth) || depth < 0) {
      // A negative or non-numeric value would silently become "unlimited" in
      // every comparison below. Refuse the configuration instead.
      throw new RangeError(
        `${DOWNLINE_DEPTH_SETTING} must be a non-negative integer (0 = unlimited), received ${JSON.stringify(value)}`,
      );
    }
    return Math.trunc(depth);
  };

  return {
    visibleDownlineDepth,

    async assertCanViewUser(actor: SessionActor, targetId: string): Promise<void> {
      if (isStaffActor(actor)) return;
      if (actor.userId === targetId) return;

      const rows = await db.$queryRaw<Array<{ depth: number }>>`
        SELECT depth FROM user_closure
        WHERE ancestor_id = ${actor.userId}::uuid AND descendant_id = ${targetId}::uuid
      `;

      const maxDepth = await visibleDownlineDepth();
      if (rows.length === 0) throw new ForbiddenError("target is outside the actor's subtree");
      if (maxDepth > 0 && rows[0].depth > maxDepth) {
        throw new ForbiddenError(`downline depth ${rows[0].depth} exceeds ${DOWNLINE_DEPTH_SETTING}`);
      }
    },

    async scopeFilter(actor: SessionActor, options: ScopeOptions = {}): Promise<NetworkScope> {
      if (isStaffActor(actor)) return UNRESTRICTED_SCOPE;

      const maxDepth = narrowDepthCap(
        await visibleDownlineDepth(),
        options.requestedMaxDepth ?? 0,
      );

      const alias = options.alias ?? DEFAULT_SCOPE_ALIAS;
      if (!SQL_IDENTIFIER_RE.test(alias)) {
        // Not sanitising it here would let a caller turn the identifier slot
        // into arbitrary SQL; the value never comes from user input, but a
        // guard that trusts its own callers is one refactor away from a hole.
        throw new RangeError(
          `scopeFilter alias must be a bare SQL identifier, received ${JSON.stringify(alias)}`,
        );
      }

      // The depth test is written into SQL instead of being applied in JS so
      // that the row count, the pagination and the sort all already respect it.
      // `maxDepth = 0` short-circuits to "any depth" inside the database.
      //
      // `Prisma.raw` is used for the alias alone, and only after the identifier
      // check above: it is the single slot that cannot be a bind parameter.
      // Interpolating it as a value instead would produce `sc.descendant_id =
      // $1.id`, which Postgres rejects.
      const descendantColumn = Prisma.raw(`${alias}.id`);
      const fragment = Prisma.sql`EXISTS (
          SELECT 1
          FROM user_closure sc
          WHERE sc.ancestor_id = ${actor.userId}::uuid
            AND sc.descendant_id = ${descendantColumn}
            AND (${maxDepth}::int = 0 OR sc.depth <= ${maxDepth}::int)
        )`;

      return {
        fragment,
        bindings: [actor.userId, maxDepth, maxDepth],
        unrestricted: false,
        maxDepth,
      };
    },
  };
}

/** Process-wide guard, wired to Prisma and the cached settings reader. */
export const authorization: Authorization = createAuthorization(prisma, processSettings);

/**
 * Narrow a session to the actor shape, dropping the fields authorization never
 * looks at. Explicit on purpose: passing the whole payload around invites
 * code that reads `fullName` from an authorization decision.
 */
export function toActor(session: SessionPayload): SessionActor {
  return { userId: session.userId, role: session.role };
}
