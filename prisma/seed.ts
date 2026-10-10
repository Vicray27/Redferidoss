// =============================================================================
// prisma/seed.ts — idempotent F1 bootstrap (pnpm seed:root).
//
// Writes, in this order:
//   1. the root user          (sponsor_id NULL, depth 0, path 'root')
//   2. the §6 settings catalog (lib/settings-catalog.ts)
//   3. the base payment_methods catalog (§5.6)
//   4. the current payment cycle (§5.4 bounds from §6 settings)
//
// Running it twice is a no-op: every write is `ON CONFLICT DO NOTHING`, except
// the root user, which is guarded by an existence check. See the note on that
// check below — it is a hard requirement, not an optimisation.
//
// ---------------------------------------------------------------------------
// Credentials NEVER come from this file
// ---------------------------------------------------------------------------
// The root password is read from ROOT_PASSWORD (ROOT_EMAIL for the address) and
// hashed with Argon2id. The seed refuses to run without them: a default or
// generated password committed to git would be a permanent backdoor, and §18
// forbids business parameters in code for the same reason.
//
//   ROOT_EMAIL=root@example.com
//   ROOT_PASSWORD=<a strong password, only used for this initial seed>
//
// On the server (no docker daemon on the workstation), after
// `pnpm db:migrate`:
//   docker run --rm -v "$PWD:/app" -w /app --network <red-del-stack> \
//     -e DATABASE_URL=... -e ROOT_EMAIL=... -e ROOT_PASSWORD=... \
//     node:24-alpine sh -lc "corepack enable && pnpm install \
//     --no-frozen-lockfile && pnpm db:migrate && pnpm seed:root"
// =============================================================================

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { computeCycleBounds, type CycleFrequency } from "../lib/cycles";
import { hashPassword } from "../lib/password";
import { SETTINGS_CATALOG, type CatalogEntry } from "../lib/settings-catalog";

/**
 * Why the root needs a SELECT guard and not just ON CONFLICT DO NOTHING:
 * `fn_user_tree_insert()` is a BEFORE INSERT trigger, and BEFORE triggers fire
 * BEFORE the unique indexes are evaluated. So a second root insert raises
 * `ROOT_ALREADY_EXISTS` from inside the trigger instead of being swallowed by
 * ON CONFLICT. The check below has to run first. (A concurrent double-seed can
 * still race between the SELECT and the INSERT; the seed is a single operator
 * action, and the partial unique index `uq_users_single_root` is the backstop.)
 */

/** §5.6 base catalog; the `payment_method` enum names are fixed by 0001_init. */
const PAYMENT_METHODS: ReadonlyArray<{
  code: string;
  label: string;
  requiresReference: boolean;
  sortOrder: number;
}> = [
  { code: "TRANSFER", label: "Transferencia", requiresReference: true, sortOrder: 1 },
  { code: "MOBILE", label: "Pago movil", requiresReference: true, sortOrder: 2 },
  { code: "ZELLE", label: "Zelle", requiresReference: true, sortOrder: 3 },
  { code: "CASH", label: "Efectivo", requiresReference: false, sortOrder: 4 },
  { code: "CRYPTO", label: "Cripto", requiresReference: true, sortOrder: 5 },
  { code: "OTHER", label: "Otro", requiresReference: false, sortOrder: 6 },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is required to run the seed. It is intentionally not defaulted: ` +
        `a committed or generated root password would be a permanent backdoor.`,
    );
  }
  return value;
}

function toJsonParam(value: CatalogEntry["value"]): string {
  return JSON.stringify(value);
}

/**
 * `public_code` is the human-readable handle used in `/r/{public_code}`
 * (§5.1: 8 chars, base32 without ambiguous glyphs). A RANDOM code would make
 * the seed non-reproducible, so the root's is derived from its email with the
 * same alphabet: stable across environments, still 8 chars, and not guessable
 * from "ROOT".
 */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I/L/O/U

export function derivePublicCode(email: string): string {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest();
  let code = "";
  for (let i = 0; code.length < 8; i++) {
    code += BASE32_ALPHABET[digest[i % digest.length] % BASE32_ALPHABET.length];
  }
  return code;
}

export async function seedDatabase(client: PrismaClient = new PrismaClient()): Promise<void> {
  try {
    await seedRootUser(client);
    await seedSettings(client);
    await seedPaymentMethods(client);
    await seedCurrentCycle(client);
  } finally {
    await client.$disconnect();
  }
}

async function seedRootUser(client: PrismaClient): Promise<void> {
  const existing = await client.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users WHERE sponsor_id IS NULL LIMIT 1
  `;
  if (existing.length > 0) {
    console.log("· root user: already present, skipped");
    return;
  }

  const email = requireEnv("ROOT_EMAIL");
  const password = requireEnv("ROOT_PASSWORD");
  const passwordHash = await hashPassword(password);

  // `path`, `depth` and `id` are intentionally absent: BEFORE INSERT
  // fn_user_tree_insert() derives them (D3 forbids writing path by hand).
  // `email` is CITEXT, so it is cast explicitly — Prisma cannot type it.
  const publicCode = derivePublicCode(email);
  const inserted = await client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO users (public_code, sponsor_id, role, email, password_hash, full_name, status)
    VALUES (${publicCode}, NULL, 'ROOT', ${email}::citext, ${passwordHash}, ${"Administrador ROOT"}, 'ACTIVE')
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    console.log("· root user: lost the race against a concurrent seed, skipped");
    return;
  }
  console.log(`· root user: created (${email}, public_code ${publicCode})`);
}

async function seedSettings(client: PrismaClient): Promise<void> {
  for (const entry of SETTINGS_CATALOG) {
    await client.$executeRaw`
      INSERT INTO settings (
        key, value, type, group_name, label, description,
        min_value, max_value, options, is_public, editable_by
      )
      VALUES (
        ${entry.key},
        ${toJsonParam(entry.value)}::jsonb,
        ${entry.type}::setting_type,
        ${entry.groupName},
        ${entry.label},
        ${entry.description},
        ${entry.minValue ?? null},
        ${entry.maxValue ?? null},
        ${entry.options ? JSON.stringify(entry.options) : null}::jsonb,
        ${entry.isPublic},
        ${entry.editableBy}::user_role
      )
      ON CONFLICT (key) DO NOTHING
    `;
  }
  console.log(`· settings: ${SETTINGS_CATALOG.length} keys of the §6 catalog ensured`);
}

async function seedPaymentMethods(client: PrismaClient): Promise<void> {
  for (const method of PAYMENT_METHODS) {
    await client.$executeRaw`
      INSERT INTO payment_methods (code, label, requires_reference, requires_proof, is_active, sort_order)
      VALUES (${method.code}, ${method.label}, ${method.requiresReference}, ${false}, ${true}, ${method.sortOrder})
      ON CONFLICT (code) DO NOTHING
    `;
  }
  console.log(`· payment_methods: ${PAYMENT_METHODS.length} base methods ensured`);
}

async function seedCurrentCycle(client: PrismaClient): Promise<void> {
  // Read the settings that define the window instead of hardcoding them: this
  // is the same rule the app follows, exercised by the seed itself.
  const rows = await client.$queryRaw<Array<{ key: string; value: unknown }>>`
    SELECT key, value FROM settings
    WHERE key IN ('general.timezone', 'payments.week_start_day', 'payments.grace_hours', 'payments.frequency')
  `;
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const timezone = typeof byKey.get("general.timezone") === "string"
    ? (byKey.get("general.timezone") as string)
    : "America/Caracas";
  const weekStartDay = Number(byKey.get("payments.week_start_day") ?? 1);
  const graceHours = Number(byKey.get("payments.grace_hours") ?? 48);
  const frequency = String(byKey.get("payments.frequency") ?? "WEEKLY") as CycleFrequency;

  const bounds = computeCycleBounds({ now: new Date(), timezone, weekStartDay, graceHours, frequency });

  const inserted = await client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO payment_cycles (period_key, starts_at, ends_at, due_at, status)
    VALUES (${bounds.periodKey}, ${bounds.startsAt}, ${bounds.endsAt}, ${bounds.dueAt}, 'OPEN')
    ON CONFLICT (period_key) DO NOTHING
    RETURNING id
  `;

  const detail = `${bounds.periodKey} [${bounds.startsAt.toISOString()} -> ${bounds.endsAt.toISOString()})`;
  console.log(
    inserted.length === 0
      ? `· payment_cycle: ${detail} already present, skipped`
      : `· payment_cycle: created ${detail}`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  seedDatabase().catch((error: unknown) => {
    console.error("\nSeed failed:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}