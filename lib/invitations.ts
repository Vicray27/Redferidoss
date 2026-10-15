// =============================================================================
// lib/invitations.ts — referral links, quota math and the pending-request
// rules of §8.2 (R2, R3).
//
// TWO WAYS IN, AND WHY THEY ARE NOT THE SAME ROW
// ----------------------------------------------
// 1. The PERMANENT link `/r/{public_code}` is the primary flow (D19): every
//    user's `public_code` is a standing, multi-use handle. It has NO row in
//    `invitations`; the handle is the user row itself. `referral.
//    allow_multi_use_link` can switch the whole mode off (§6).
// 2. A SINGLE-USE invitation is the `invitations` row of §5.3: 32 random bytes
//    in base64url, only SHA-256 stored (§13.2), `max_uses = 1`, expiry from
//    `referral.invite_ttl_hours`. The plain token exists only in the link.
//
// THE QUOTA IS NOT `${max} - children` — PENDING LINKS RESERVE SLOTS
// ------------------------------------------------------------------
// R3: when `referral.count_pending_in_limit` is true (default), an unconsumed
// invitation occupies a slot, so a user cannot hand out 12 links against a
// quota of 2 and over-subscribe the network. Which makes the arithmetic
// slightly subtle at the moment an invitation is about to be CONSUMED:
//
//   * Resolution for the permanent link counts every pending invitation: those
//     links are all still competing for the same free slots.
//   * Resolution for a SINGLE invitation EXCLUDES that invitation from the
//     pending count. The link exists precisely to fill a reserved slot; if it
//     counted against itself, the invited person would be told "no slots" the
//     moment the invitation was issued to them. Net effect over the whole
//     lifecycle: children +1 and pending −1, so `used` is unchanged.
//
// Every statement is parameterised and carries a `/* @inv:… */` marker. The
// markers exist so `tests/invitations.test.ts` can route a fake client by
// intent instead of by fragile string shape, the same spirit as the injected
// loaders of lib/settings.ts (D9) and lib/users.ts (D14).
// =============================================================================

import { createHash, randomBytes } from "node:crypto";

import { AppError } from "./errors";
import type { SettingsLike } from "./authz";

/** §6 keys this module reads. No defaults: a mis-seeded DB must fail loudly. */
export const ALLOW_MULTI_USE_LINK_SETTING = "referral.allow_multi_use_link";
export const COUNT_PENDING_IN_LIMIT_SETTING = "referral.count_pending_in_limit";
export const INVITE_TTL_HOURS_SETTING = "referral.invite_ttl_hours";
export const MAX_DEPTH_SETTING = "referral.max_depth";

/**
 * The single message every unusable link shows.
 *
 * Exists so "no existe", "expirado", "revocado" and "ya usado" are one bucket
 * from the outside: telling them apart would let a stranger walk the space of
 * tokens (or codes) by watching which failure comes back. The precise cause
 * travels in `reason`, for logs and tests only.
 */
export const INVITE_INVALID_MESSAGE =
  "Este link de invitación no es válido o ya no está disponible.";

/** Canonical 404 for every unusable link (A2). */
export class InviteInvalidError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super(404, "INVITE_INVALID", INVITE_INVALID_MESSAGE);
    this.name = "InviteInvalidError";
    this.reason = reason;
  }
}

/** Shown when the sponsor has no free slot left (A2 "sin cupo"). */
export const NO_SLOTS_MESSAGE = "No hay cupos de referido disponibles en este momento.";

/** 409 — the quota is exhausted, at resolution time or in the A3 race. */
export class ReferralLimitError extends AppError {
  constructor(message = NO_SLOTS_MESSAGE) {
    super(409, "REFERRAL_LIMIT_REACHED", message);
    this.name = "ReferralLimitError";
  }
}

/** §5.1: the handle is 8 Crockford base32 chars — no I, L, O or U. */
const PUBLIC_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * True when `slug` is a permanent handle rather than a single-use token.
 *
 * The two are distinguishable by construction: handles are exactly 8 chars of
 * Crockford base32, tokens are 43 chars of base64url.
 */
export function looksLikePublicCode(slug: string): boolean {
  return PUBLIC_CODE_RE.test(slug.trim().toUpperCase());
}

/** §13.2: 32 random bytes in base64url; the plain value only travels in the link. */
export function generateInviteToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

/** §13.2: only SHA-256(token) is stored (§5.3, uq_invitations_token_hash). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ReferralQuota {
  /** Direct, non-deleted children — they own their slots. */
  children: number;
  /** Unconsumed, unexpired, non-revoked invitations considered for the limit. */
  pending: number;
  /** Effective cap: `max_referrals_override` else `referral.max_direct_referrals`. */
  max: number;
  /** `children + pending` when R3 applies, `children` otherwise. */
  used: number;
  /** Free slots, never negative. `0` is a legitimate "sin cupo" state. */
  left: number;
}

/**
 * Pure quota math, so the R3 rules are unit-testable without a database.
 *
 * `left` is clamped at zero: a quota that was lowered below current usage
 * (A1: 12 → 10 with 11 children) must read as 0 free slots, not as −1.
 */
export function computeQuota(
  children: number,
  pending: number,
  max: number,
  countPendingInLimit: boolean,
): ReferralQuota {
  const c = Math.max(0, Math.trunc(children));
  const p = Math.max(0, Math.trunc(pending));
  const m = Math.max(0, Math.trunc(max));
  const counted = countPendingInLimit ? p : 0;
  const used = c + counted;
  return { children: c, pending: p, max: m, used, left: Math.max(0, m - used) };
}

/** Expiry instant for a new invitation, or null when the TTL is 0/absent. */
export function inviteExpiry(now: Date, ttlHours: number): Date | null {
  const hours = Math.trunc(ttlHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** One custom field the registration form must render (§8.3, §12). */
export interface RegistrationField {
  code: string;
  label: string;
  type: string;
  options: unknown;
  isRequired: boolean;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
  sortOrder: number;
}

export interface SponsorInfo {
  id: string;
  publicCode: string;
  fullName: string;
  depth: number;
}

export interface InviteResolution {
  kind: "PERMANENT" | "SINGLE";
  /** The invitation row to consume on success; null for the permanent link. */
  invitationId: string | null;
  /** Set on SINGLE invitations when the link was addressed to one email. */
  emailTarget: string | null;
  sponsor: SponsorInfo;
  slots: ReferralQuota;
  /** Fields the form must render, straight from custom_fields (§8.3). */
  fields: RegistrationField[];
}

export interface PendingInvitation {
  id: string;
  kind: string;
  emailTarget: string | null;
  maxUses: number;
  uses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: Date | null;
}

/** Minimal raw-query client, same structural type as lib/users.ts. */
export type InvitationsDb = {
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

export interface InvitationsOptions {
  now?: () => Date;
}

export interface InvitationsService {
  /** Resolve `/r/{code}` (permanent) or `/invite/{token}` (single use). */
  resolveInvite(slug: string): Promise<InviteResolution>;
  /** Fresh quota for a sponsor, from the database (used after the row lock). */
  quotaFor(userId: string, options?: { excludeInvitationId?: string }): Promise<ReferralQuota>;
  /** Unconsumed invitations, newest first (the §8.2 "pendientes" list). */
  listPending(userId: string): Promise<PendingInvitation[]>;
  /**
   * Issue a single-use token after validating the quota (§8.2).
   *
   * `expiresInHours`: omitted/null falls back to `referral.invite_ttl_hours`;
   * an explicit value wins, and 0 issues a link without expiry.
   */
  createSingleUse(
    inviterId: string,
    input?: { emailTarget?: string | null; expiresInHours?: number | null },
  ): Promise<CreatedInvitation>;
  /** Revoke one of the caller's own invitations. False when not found/owned. */
  revoke(userId: string, invitationId: string): Promise<boolean>;
  /**
   * Consume one use inside the registration transaction. False when the row is
   * revoked, expired or exhausted — the caller turns that into a 404.
   */
  consume(invitationId: string): Promise<boolean>;
}

/** Postgres counts arrive as bigint (int8); the app speaks number. */
function toCount(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

interface SponsorRow {
  id: string;
  publicCode: string;
  fullName: string;
  depth: number;
  status: string;
}

interface InvitationRow {
  id: string;
  inviterId: string;
  kind: string;
  emailTarget: string | null;
  maxUses: number;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface QuotaRow {
  children: unknown;
  max: unknown;
  pending: unknown;
}

export function createInvitationsService(
  db: InvitationsDb,
  settings: SettingsLike,
  options: InvitationsOptions = {},
): InvitationsService {
  const now = options.now ?? (() => new Date());

  const fieldsForRegistration = async (): Promise<RegistrationField[]> => {
    const rows = await db.$queryRaw<RegistrationField[]>`
      /* @inv:fields */
      SELECT
        code,
        label,
        type,
        options,
        is_required  AS "isRequired",
        regex,
        min_numeric::text AS "minNumeric",
        max_numeric::text AS "maxNumeric",
        sort_order   AS "sortOrder"
      FROM custom_fields
      WHERE entity = 'USER' AND is_active = TRUE AND show_in_registration = TRUE
      ORDER BY sort_order, label
    `;
    return rows;
  };

  const quotaFor = async (
    userId: string,
    quotaOptions: { excludeInvitationId?: string } = {},
  ): Promise<ReferralQuota> => {
    const countPending = Boolean(
      await settings.getOrThrow<boolean>(COUNT_PENDING_IN_LIMIT_SETTING),
    );
    const exclude = quotaOptions.excludeInvitationId ?? null;

    const rows = await db.$queryRaw<QuotaRow[]>`
      /* @inv:quota */
      SELECT
        (SELECT count(*) FROM users ch
          WHERE ch.sponsor_id = u.id AND ch.deleted_at IS NULL) AS children,
        fn_effective_max_referrals(u.id) AS max,
        (SELECT count(*) FROM invitations i
          WHERE i.inviter_id = u.id
            AND i.revoked_at IS NULL
            AND (i.expires_at IS NULL OR i.expires_at > now())
            AND i.uses < i.max_uses
            AND (${exclude}::uuid IS NULL OR i.id <> ${exclude}::uuid)) AS pending
      FROM users u
      WHERE u.id = ${userId}::uuid
    `;

    const row = rows[0];
    if (!row) throw new InviteInvalidError("sponsor not found while reading quota");
    return computeQuota(toCount(row.children), toCount(row.pending), toCount(row.max), countPending);
  };

  const sponsorByCode = async (code: string): Promise<SponsorRow | null> => {
    const rows = await db.$queryRaw<SponsorRow[]>`
      /* @inv:sponsor-by-code */
      SELECT
        u.id,
        u.public_code AS "publicCode",
        u.full_name   AS "fullName",
        u.depth,
        u.status::text AS status
      FROM users u
      WHERE u.public_code = ${code} AND u.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  };

  const sponsorById = async (id: string): Promise<SponsorRow | null> => {
    const rows = await db.$queryRaw<SponsorRow[]>`
      /* @inv:sponsor-by-id */
      SELECT
        u.id,
        u.public_code AS "publicCode",
        u.full_name   AS "fullName",
        u.depth,
        u.status::text AS status
      FROM users u
      WHERE u.id = ${id}::uuid AND u.deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  };

  const invitationByHash = async (hash: string): Promise<InvitationRow | null> => {
    const rows = await db.$queryRaw<InvitationRow[]>`
      /* @inv:invitation-by-hash */
      SELECT
        i.id,
        i.inviter_id AS "inviterId",
        i.kind::text AS kind,
        i.email_target::text AS "emailTarget",
        i.max_uses AS "maxUses",
        i.uses,
        i.expires_at AS "expiresAt",
        i.revoked_at AS "revokedAt"
      FROM invitations i
      WHERE i.token_hash = ${hash}
      LIMIT 1
    `;
    return rows[0] ?? null;
  };

  /** A sponsor that cannot take referrals makes every link to it unusable. */
  const assertUsableSponsor = (sponsor: SponsorRow, reason: string): SponsorInfo => {
    if (sponsor.status !== "ACTIVE") {
      throw new InviteInvalidError(`${reason}: sponsor status is ${sponsor.status}`);
    }
    return {
      id: sponsor.id,
      publicCode: sponsor.publicCode,
      fullName: sponsor.fullName,
      depth: sponsor.depth,
    };
  };

  const resolvePermanent = async (code: string): Promise<InviteResolution> => {
    const allowed = Boolean(await settings.getOrThrow<boolean>(ALLOW_MULTI_USE_LINK_SETTING));
    if (!allowed) throw new InviteInvalidError("permanent links are disabled by settings");

    const sponsorRow = await sponsorByCode(code.trim().toUpperCase());
    if (!sponsorRow) throw new InviteInvalidError("unknown public_code");

    const sponsor = assertUsableSponsor(sponsorRow, "permanent link");
    const [slots, fields] = await Promise.all([
      quotaFor(sponsor.id),
      fieldsForRegistration(),
    ]);

    return { kind: "PERMANENT", invitationId: null, emailTarget: null, sponsor, slots, fields };
  };

  const resolveToken = async (token: string): Promise<InviteResolution> => {
    const row = await invitationByHash(hashInviteToken(token));
    if (!row) throw new InviteInvalidError("unknown token");
    if (row.revokedAt) throw new InviteInvalidError("token revoked");
    if (row.expiresAt && row.expiresAt.getTime() <= now().getTime()) {
      throw new InviteInvalidError("token expired");
    }
    if (row.uses >= row.maxUses) throw new InviteInvalidError("token exhausted");

    const sponsorRow = await sponsorById(row.inviterId);
    if (!sponsorRow) throw new InviteInvalidError("inviter not found");

    const sponsor = assertUsableSponsor(sponsorRow, "single-use token");
    // The invitation being resolved does not count against itself: see the
    // header note on the consume-time arithmetic.
    const [slots, fields] = await Promise.all([
      quotaFor(sponsor.id, { excludeInvitationId: row.id }),
      fieldsForRegistration(),
    ]);

    return {
      kind: "SINGLE",
      invitationId: row.id,
      emailTarget: row.emailTarget,
      sponsor,
      slots,
      fields,
    };
  };

  return {
    async resolveInvite(slug: string): Promise<InviteResolution> {
      const raw = slug.trim();
      if (raw === "") throw new InviteInvalidError("empty slug");
      return looksLikePublicCode(raw) ? resolvePermanent(raw) : resolveToken(raw);
    },

    quotaFor,

    async listPending(userId: string): Promise<PendingInvitation[]> {
      return db.$queryRaw<PendingInvitation[]>`
        /* @inv:list-pending */
        SELECT
          i.id,
          i.kind::text AS kind,
          i.email_target::text AS "emailTarget",
          i.max_uses AS "maxUses",
          i.uses,
          i.expires_at AS "expiresAt",
          i.created_at AS "createdAt"
        FROM invitations i
        WHERE i.inviter_id = ${userId}::uuid
          AND i.revoked_at IS NULL
          AND (i.expires_at IS NULL OR i.expires_at > now())
          AND i.uses < i.max_uses
        ORDER BY i.created_at DESC
      `;
    },

    async createSingleUse(inviterId, input = {}): Promise<CreatedInvitation> {
      // §8.2 "Antes de emitir: validar cupo disponible". Without the exclusion,
      // the new row would reserve its own slot twice; quotaFor counts what is
      // already pending, and the insert below adds exactly one more.
      const quota = await quotaFor(inviterId);
      if (quota.left <= 0) throw new ReferralLimitError();

      const ttlHours =
        input.expiresInHours === undefined || input.expiresInHours === null
          ? Number(await settings.getOrThrow<number>(INVITE_TTL_HOURS_SETTING))
          : Number(input.expiresInHours);
      const expiresAt = inviteExpiry(now(), ttlHours);
      const token = generateInviteToken();
      const emailTarget =
        input.emailTarget && input.emailTarget.trim() !== ""
          ? input.emailTarget.trim().toLowerCase()
          : null;

      const rows = await db.$queryRaw<Array<{ id: string }>>`
        /* @inv:insert */
        INSERT INTO invitations (inviter_id, token_hash, kind, email_target, max_uses, expires_at)
        VALUES (
          ${inviterId}::uuid,
          ${hashInviteToken(token)},
          'SINGLE'::invite_kind,
          ${emailTarget}::citext,
          1,
          ${expiresAt}
        )
        RETURNING id
      `;

      const row = rows[0];
      if (!row) throw new AppError(500, "INTERNAL_ERROR", "No se pudo crear la invitación.");
      return { id: row.id, token, expiresAt };
    },

    async revoke(userId: string, invitationId: string): Promise<boolean> {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        /* @inv:revoke */
        UPDATE invitations
        SET revoked_at = now()
        WHERE id = ${invitationId}::uuid
          AND inviter_id = ${userId}::uuid
          AND revoked_at IS NULL
        RETURNING id
      `;
      return rows.length > 0;
    },

    async consume(invitationId: string): Promise<boolean> {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        /* @inv:consume */
        UPDATE invitations
        SET uses = uses + 1
        WHERE id = ${invitationId}::uuid
          AND revoked_at IS NULL
          AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING id
      `;
      return rows.length > 0;
    },
  };
}
