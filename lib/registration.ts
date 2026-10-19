// =============================================================================
// lib/registration.ts — the §8.3 self-registration flow (R2, R3, R4, A3).
//
// WHY EVERYTHING HAPPENS INSIDE ONE TRANSACTION
// ---------------------------------------------
// Registration is the one place where quota, depth and the invitation state
// must be checked and consumed atomically, or two simultaneous registrations
// under the same sponsor both see the last free slot. The §8.4 pseudocode is
// explicit: resolve the invite, `SELECT … FOR UPDATE` the sponsor, THEN
// re-validate. The order matters twice over:
//
//   1. The lock serializes concurrent registrations under one sponsor, so the
//      quota check right after it sees the other transaction's child.
//   2. The invitation is resolved a SECOND time after the lock: the first
//      resolve only identifies the sponsor. Revoked/consumed/expired state
//      observed before the lock is a snapshot, and acting on a snapshot is
//      exactly the A3 bug.
//
// `path`, `depth` and `user_closure` are NEVER written here: the database
// triggers of §5.8 derive them (fn_user_tree_insert already locks the parent
// on its own). Password hashing happens BEFORE the transaction opens — Argon2
// is deliberately slow and holding the sponsor lock through it would serialize
// every registration on the CPU instead of on the row.
//
// ANTI-ENUMERATION (A2, §13)
// --------------------------
// "email already registered" and "everything was fine" must be
// indistinguishable to an anonymous caller: duplicate email returns the same
// generic 409 as any other conflict. The email_target of a directed invitation
// is enforced too, and the same generic error is returned when it does not
// match — a probe learns nothing either way.
//
// All statements carry `/* @reg:… */` markers so tests can route a fake
// client by intent, mirroring lib/invitations.ts.
// =============================================================================

import { randomBytes } from "node:crypto";

import { AppError, ValidationError } from "./errors";
import {
  assertCustomValuesUnique,
  collectCustomValues,
  isValidEmail,
  type CustomFieldRow,
} from "./custom-fields";
import {
  MAX_DEPTH_SETTING,
  type InvitationsService,
  type RegistrationField,
} from "./invitations";
import type { SettingsLike } from "./authz";
import { readPasswordMinLength } from "./security-settings";

/** §6 keys this module reads. No defaults: a mis-seeded DB must fail loudly. */
export const AUTO_APPROVE_SETTING = "referral.auto_approve_registration";
export const REQUIRE_EMAIL_VERIFICATION_SETTING = "referral.require_email_verification";
export const PENDING_AMOUNT_SETTING = "payments.expected_amount";

/** Crockford base32 without ambiguous glyphs (§5.1), same alphabet as the seed. */
const PUBLIC_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PUBLIC_CODE_LENGTH = 8;
const PUBLIC_CODE_ATTEMPTS = 5;

/**
 * One error for every "cannot register with these data" outcome.
 *
 * Deliberately says nothing about WHY: a caller probing whether an email is
 * already in the network receives exactly what a caller who mistyped gets.
 */
export const REGISTRATION_CONFLICT_MESSAGE =
  "No se pudo completar el registro con esos datos. Si ya tienes una cuenta, inicia sesión y pide tu enlace desde el portal.";

export class RegistrationConflictError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super(409, "REGISTRATION_CONFLICT", REGISTRATION_CONFLICT_MESSAGE);
    this.name = "RegistrationConflictError";
    this.reason = reason; // logs and tests only, never in `message`
  }
}

/** R4 — the tree refuses to grow past `referral.max_depth` (0 = unlimited). */
export class DepthLimitError extends AppError {
  constructor() {
    super(409, "DEPTH_LIMIT_REACHED", "La red alcanzó su profundidad máxima.");
    this.name = "DepthLimitError";
  }
}

export interface RegistrationInput {
  /** Permanent code or single-use token, exactly as it arrived in the form. */
  invite: string;
  email: string;
  password: string;
  fullName: string;
  nationalId?: string | null;
  phone?: string | null;
  birthDate?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  address?: string | null;
  /** Values keyed by custom field `code` (§8.3 dynamic fields). */
  custom?: Record<string, unknown> | null;
}

export interface RegistrationContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface RegistrationResult {
  userId: string;
  publicCode: string;
  email: string;
  fullName: string;
  status: "ACTIVE" | "PENDING";
  sponsorId: string;
  sponsorName: string;
  invitationKind: "PERMANENT" | "SINGLE";
  /** False when there is no OPEN cycle yet (see the obligation note below). */
  obligationCreated: boolean;
}

/** Raw client of one transaction; same shape as InvitationsDb. */
export type RegistrationTx = {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

export interface RegistrationDb {
  $transaction<T>(fn: (tx: RegistrationTx) => Promise<T>): Promise<T>;
}

export interface RegistrationDeps {
  db: RegistrationDb;
  settings: SettingsLike;
  /**
   * Build the invitations service over the CURRENT transaction, so quota and
   * consumption read and write inside the same atomic unit (§8.4).
   */
  invitationsFor(tx: RegistrationTx): InvitationsService;
  /** lib/password.hashPassword wired with ARGON2_OPTIONS. */
  hashPassword(plain: string): Promise<string>;
  /** Injectable for deterministic tests; production uses randomPublicCode(). */
  generatePublicCode(): string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and for the form in WU3). Custom-field
// validation lives in lib/custom-fields.ts — one authority per rule (D56).
// ---------------------------------------------------------------------------

/** Random 8-char handle. Random, not derived: a derived code would be a reversible fingerprint of the email. */
export function randomPublicCode(
  random: (size: number) => Buffer = randomBytes,
): string {
  const bytes = random(PUBLIC_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < PUBLIC_CODE_LENGTH; i++) {
    code += PUBLIC_CODE_ALPHABET[bytes[i] % PUBLIC_CODE_ALPHABET.length];
  }
  return code;
}

/** Trimmed string or null; "" and whitespace are stored as NULL, not as empty text. */
export function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Prisma surfaces the Postgres unique violation as 23505 inside meta.code. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === "23505" || candidate.meta?.code === "23505";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface LockedSponsorRow {
  id: string;
  depth: number;
  status: string;
}

interface InsertedUserRow {
  id: string;
  publicCode: string;
  status: string;
}

export async function registerUser(
  input: RegistrationInput,
  context: RegistrationContext,
  deps: RegistrationDeps,
): Promise<RegistrationResult> {
  // --- cheap shape validation + hashing BEFORE the transaction --------------
  const fieldErrors: Record<string, string[]> = {};
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) fieldErrors.email = ["Ingresa un correo válido."];
  // F8 (§18.3): the minimum comes from `security.password_min_length`, read
  // here as the server-side authority; the route schema enforces the same
  // value so the client error is per-field before this ever runs.
  const minPasswordLength = await readPasswordMinLength(deps.settings);
  if (input.password.length < minPasswordLength) {
    fieldErrors.password = [
      `La contraseña debe tener al menos ${minPasswordLength} caracteres.`,
    ];
  }
  const fullName = input.fullName.trim();
  if (fullName === "") fieldErrors.fullName = ["Ingresa tu nombre completo."];
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("Revisa los datos del formulario.", fieldErrors);
  }

  // Argon2 is intentionally expensive; doing it inside the transaction would
  // hold the sponsor lock for ~100ms per call.
  const passwordHash = await deps.hashPassword(input.password);

  return deps.db.$transaction(async (tx) => {
    const invitations = deps.invitationsFor(tx);

    // First resolve: identifies the sponsor (404 for any unusable link).
    const initial = await invitations.resolveInvite(input.invite);

    // §8.4: lock the sponsor, THEN re-validate. The lock is what makes the
    // quota check below truthful under concurrency (A3).
    const lockedRows = await tx.$queryRaw<LockedSponsorRow[]>`
      /* @reg:lock-sponsor */
      SELECT u.id, u.depth, u.status::text AS status
      FROM users u
      WHERE u.id = ${initial.sponsor.id}::uuid
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (!locked) throw new AppError(500, "INTERNAL_ERROR", "No se pudo bloquear al patrocinador.");

    // Second resolve: fresh invitation state + fresh quota, now that every
    // competing transaction under this sponsor is behind us.
    const invite = await invitations.resolveInvite(input.invite);

    if (locked.status !== "ACTIVE") {
      throw new AppError(404, "INVITE_INVALID", "Este enlace de invitación no es válido o ya no está disponible.");
    }

    // A directed invitation only works for the email it was sent to.
    if (invite.emailTarget && invite.emailTarget.trim().toLowerCase() !== email) {
      throw new RegistrationConflictError("invitation email_target does not match");
    }

    // R4 — depth cap (0 = unlimited). The child sits at sponsor.depth + 1.
    const maxDepth = Number(await deps.settings.getOrThrow<number>(MAX_DEPTH_SETTING));
    if (maxDepth > 0 && locked.depth + 1 > maxDepth) throw new DepthLimitError();

    // R2/R3 — quota, computed excluding this invitation for SINGLE links.
    if (invite.slots.left <= 0) {
      throw new AppError(409, "REFERRAL_LIMIT_REACHED", "No hay cupos de referido disponibles en este momento.");
    }

    // Email availability: pre-check for the common case, and the unique index
    // as the race-proof backstop mapped below.
    const emailRows = await tx.$queryRaw<Array<{ one: number }>>`
      /* @reg:email-exists */
      SELECT 1 AS one FROM users WHERE email = ${email}::citext LIMIT 1
    `;
    if (emailRows.length > 0) {
      throw new RegistrationConflictError("email already registered");
    }

    // Handle availability: random codes, retried on collision.
    let publicCode = deps.generatePublicCode();
    for (
      let attempt = 0;
      attempt < PUBLIC_CODE_ATTEMPTS &&
      (await tx.$queryRaw<Array<{ one: number }>>`
        /* @reg:code-exists */
        SELECT 1 AS one FROM users WHERE public_code = ${publicCode} LIMIT 1
      `).length > 0;
      attempt++
    ) {
      publicCode = deps.generatePublicCode();
    }

    const autoApprove = Boolean(await deps.settings.getOrThrow<boolean>(AUTO_APPROVE_SETTING));
    const requireVerification = Boolean(
      await deps.settings.getOrThrow<boolean>(REQUIRE_EMAIL_VERIFICATION_SETTING),
    );
    // With no mail provider (D7) verification cannot complete, so requiring it
    // parks the user in PENDING until an admin approves — never in a state
    // that pretends the email was verified.
    const status: "ACTIVE" | "PENDING" =
      autoApprove && !requireVerification ? "ACTIVE" : "PENDING";

    let inserted: InsertedUserRow;
    try {
      const rows = await tx.$queryRaw<InsertedUserRow[]>`
        /* @reg:insert-user */
        INSERT INTO users (
          public_code, sponsor_id, email, password_hash, full_name,
          national_id, phone, birth_date, country, state, city, address, status
        )
        VALUES (
          ${publicCode},
          ${locked.id}::uuid,
          ${email}::citext,
          ${passwordHash},
          ${fullName},
          ${emptyToNull(input.nationalId)},
          ${emptyToNull(input.phone)},
          ${emptyToNull(input.birthDate)}::date,
          ${emptyToNull(input.country)},
          ${emptyToNull(input.state)},
          ${emptyToNull(input.city)},
          ${emptyToNull(input.address)},
          ${status}::user_status
        )
        RETURNING id, public_code AS "publicCode", status::text AS status
      `;
      const row = rows[0];
      if (!row) throw new Error("INSERT INTO users returned no row");
      inserted = row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RegistrationConflictError("unique violation on insert (email or public_code)");
      }
      throw error;
    }

    // --- custom fields (§8.3): definitions re-read inside the transaction ---
    const customFields = await tx.$queryRaw<CustomFieldRow[]>`
      /* @reg:fields */
      SELECT
        id,
        code,
        label,
        type,
        options,
        is_required AS "isRequired",
        is_unique AS "isUnique",
        regex,
        min_numeric::text AS "minNumeric",
        max_numeric::text AS "maxNumeric",
        default_value AS "defaultValue"
      FROM custom_fields
      WHERE entity = 'USER' AND is_active = TRUE AND show_in_registration = TRUE
      ORDER BY sort_order, label
    `;
    const collected = collectCustomValues(customFields, input.custom ?? {});
    if (Object.keys(collected.errors).length > 0) {
      throw new ValidationError("Revisa los campos del formulario.", collected.errors);
    }
    // is_unique is an application check (D56); run it before writing values so
    // a clash aborts without partial inserts.
    await assertCustomValuesUnique(tx, collected.values, inserted.id);
    for (const { field, value } of collected.values) {
      await tx.$queryRaw`
        /* @reg:insert-field-value */
        INSERT INTO custom_field_values (field_id, entity_id, value)
        VALUES (${field.id}::uuid, ${inserted.id}::uuid, ${JSON.stringify(value)}::jsonb)
      `;
    }

    // --- consume the single-use invitation ----------------------------------
    if (invite.kind === "SINGLE" && invite.invitationId !== null) {
      const consumed = await invitations.consume(invite.invitationId);
        if (!consumed) {
          // Revoked or exhausted between resolve and consume: the link is no
          // longer usable and the user row just created must not survive.
          throw new AppError(404, "INVITE_INVALID", "Este enlace de invitación no es válido o ya no está disponible.");
        }
    }

    // --- obligation, only when a cycle is already open -----------------------
    // F3 ships before the cycle admin flow (F4). If no cycle is OPEN, the new
    // member joins without an obligation; the next cycle's fan-out picks them
    // up. Documented as a decision rather than guessed silently.
    const cycleRows = await tx.$queryRaw<Array<{ id: string }>>`
      /* @reg:open-cycle */
      SELECT id FROM payment_cycles
      WHERE status = 'OPEN'
      ORDER BY starts_at DESC
      LIMIT 1
    `;
    let obligationCreated = false;
    if (cycleRows.length > 0) {
      const expected = String(await deps.settings.getOrThrow<unknown>(PENDING_AMOUNT_SETTING));
      await tx.$queryRaw`
        /* @reg:insert-obligation */
        INSERT INTO cycle_obligations (cycle_id, user_id, expected_amount)
        VALUES (${cycleRows[0].id}::uuid, ${inserted.id}::uuid, ${expected}::numeric)
      `;
      obligationCreated = true;
    }

    // --- audit: no email, no password, no PII (§13) --------------------------
    await tx.$queryRaw`
      /* @reg:audit */
      INSERT INTO audit_log (actor_id, action, entity, entity_id, "after", ip, user_agent)
      VALUES (
        ${inserted.id}::uuid,
        'user.register',
        'users',
        ${inserted.id},
        ${JSON.stringify({
          sponsorId: locked.id,
          invitationKind: invite.kind,
          invitationId: invite.invitationId,
          publicCode: inserted.publicCode,
          status,
        })}::jsonb,
        ${context.ip ?? null},
        ${context.userAgent ?? null}
      )
    `;

    return {
      userId: inserted.id,
      publicCode: inserted.publicCode,
      email,
      fullName,
      status,
      sponsorId: locked.id,
      sponsorName: invite.sponsor.fullName,
      invitationKind: invite.kind,
      obligationCreated,
    };
  });
}

export type { RegistrationField };
