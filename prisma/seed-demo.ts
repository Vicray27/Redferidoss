// =============================================================================
// prisma/seed-demo.ts — §15 demo dataset (pnpm seed:demo).
//
// Creates, on top of the F1 bootstrap (settings, payment methods, current
// cycle — reused from prisma/seed.ts, not duplicated):
//   * the root (only when none exists; a pre-existing root is kept untouched),
//   * a COMPLETE tree with the requested breadth/depth — the spec example
//     12 × 3 expands to 1 + 12 + 144 + 1,728 = 1,885 users,
//   * N past weekly cycles (default 8) with ~85% compliance, variable amounts
//     and a PENDING/APPROVED/REJECTED mix plus some receipts,
//   * access credentials for the root and three members at different levels.
//
// Safety rails, all deliberate:
//   * NEVER runs with NODE_ENV=production (no override flag exists).
//   * Refuses to run over non-demo data unless `--force`; demo rows are
//     recognised by their `@demo.local` emails.
//   * Re-running is safe: users/cycles/obligations/files are written with
//     ON CONFLICT DO NOTHING and report generation is skipped once demo
//     reports exist (a partial unique index covers live reports, but REJECTED
//     rows have no constraint to conflict on — the count check is the guard).
//
// Reproducibility: every "random" choice (compliance, statuses, amounts,
// methods, receipts) comes from a seeded PRNG (mulberry32), so the same
// command yields the same dataset shape on every machine. Passwords are the
// only true randomness, generated per run and printed — never committed.
//
// Usage:
//   pnpm seed:demo                          (spec defaults: 12 × 3 × 8)
//   pnpm seed:demo --breadth=6 --depth=4 --weeks=8   (A5 scale: 1,555 users,
//                                            5 levels — for the browser test)
//   pnpm seed:demo --force                  (accept non-demo data alongside)
// =============================================================================

import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { MS_PER_DAY, computeCycleBounds, type CycleBounds, type CycleFrequency } from "../lib/cycles";
import { hashPassword } from "../lib/password";
import { BASE32_ALPHABET, derivePublicCode, seedCurrentCycle, seedPaymentMethods, seedSettings } from "./seed";

/** The spec's own example (12³ → 1,885 users, 4 levels). */
export const DEMO_PRESET_SPEC = { breadth: 12, depth: 3, weeks: 8 } as const;
/** A5 scale scenario: 6⁴ → 1,555 users and 5 levels (0..4), lighter to walk. */
export const DEMO_PRESET_SCALE = { breadth: 6, depth: 4, weeks: 8 } as const;

/** Fixed PRNG seed: the dataset shape is reproducible across machines. */
export const DEMO_RANDOM_SEED = 20261016;

const DEMO_DOMAIN = "@demo.local";
// "~85% de cumplimiento" (§15) is the HEADLINE KPI, so compliance is modeled
// on the member, not on the report: ~85% of members fulfil the week (approved
// report → FULFILLED). The non-compliant tail carries the PENDING/REJECTED
// mix the spec also asks for: 40% of the tail files PENDING, 25% files
// REJECTED, 35% files nothing (MISSED). Net: ~85% FULFILLED, ~6% PENDING,
// ~3.75% REJECTED, ~5.25% silent MISSED.
const COMPLIANCE_RATE = 0.85;
const PENDING_SHARE_OF_TAIL = 0.4;
const REJECTED_SHARE_OF_TAIL = 0.25;
const RECEIPT_RATE = 0.05;
const EXPECTED_AMOUNT_FALLBACK = "10.00";

const FIRST_NAMES = [
  "Ana", "Beto", "Carla", "Diego", "Elena", "Fabio", "Gabriela", "Hugo",
  "Irene", "Jorge", "Karina", "Luis", "María", "Nicolás", "Olga", "Pedro",
  "Quina", "Rafael", "Sofía", "Tomás", "Úrsula", "Valentina", "Walter", "Ximena",
] as const;

const LAST_NAMES = [
  "Pérez", "Gómez", "Rodríguez", "Fernández", "López", "Martínez", "Sánchez",
  "Ramírez", "Torres", "Flores", "Rivera", "Vargas", "Castro", "Rojas",
  "Mendoza", "Silva", "Navarro", "Campos", "Aguilar", "Paredes", "Salazar",
  "Ibarra", "Cabrera", "Fuentes",
] as const;

/** The §5.6 base catalog, as `code` values of the `payment_method` enum. */
const METHOD_CODES = ["TRANSFER", "MOBILE", "ZELLE", "CASH", "CRYPTO", "OTHER"] as const;
/** Codes whose catalog rows require a reference (mirrors prisma/seed.ts). */
const REFERENCE_METHODS = new Set(["TRANSFER", "MOBILE", "ZELLE", "CRYPTO"]);

export interface DemoOptions {
  breadth: number;
  depth: number;
  weeks: number;
  force: boolean;
}

export const DEMO_USAGE = [
  "Usage: pnpm seed:demo [--breadth=N] [--depth=N] [--weeks=N] [--preset=spec|scale] [--force]",
  "",
  "  --breadth=N   direct children per node (1..50, default 12)",
  "  --depth=N     tree levels below the root (0..6, default 3)",
  "  --weeks=N     past weekly cycles to generate (1..52, default 8)",
  "  --preset=spec 12 x 3 x 8 (the spec example: 1,885 users)",
  "  --preset=scale 6 x 4 x 8 (A5: 1,555 users across 5 levels)",
  "  --force       proceed even when non-demo data already exists",
].join("\n");

/** Throws on anything that is not a known flag with a valid value. */
export function parseDemoArgs(argv: readonly string[]): DemoOptions {
  let preset: { breadth: number; depth: number; weeks: number } = DEMO_PRESET_SPEC;
  const explicit = new Map<string, number>();
  let force = false;

  for (const arg of argv) {
    if (arg === "--preset=spec") {
      preset = DEMO_PRESET_SPEC;
      continue;
    }
    if (arg === "--preset=scale") {
      preset = DEMO_PRESET_SCALE;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    const match = /^--(breadth|depth|weeks)=(\d+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${DEMO_USAGE}`);
    // Collected, not applied: an explicit flag wins over --preset in any order.
    explicit.set(match[1], Number(match[2]));
  }

  const options: DemoOptions = {
    breadth: explicit.get("breadth") ?? preset.breadth,
    depth: explicit.get("depth") ?? preset.depth,
    weeks: explicit.get("weeks") ?? preset.weeks,
    force,
  };
  assertIntInRange("breadth", options.breadth, 1, 50);
  assertIntInRange("depth", options.depth, 0, 6);
  assertIntInRange("weeks", options.weeks, 1, 52);
  return options;
}

function assertIntInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}, received ${value}`);
  }
}

/** Deterministic PRNG (public-domain mulberry32); same seed, same dataset. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Total users of a complete tree: 1 + b + b² + … + b^depth. */
export function demoTreeSize(breadth: number, depth: number): number {
  let total = 1;
  let levelSize = 1;
  for (let level = 1; level <= depth; level += 1) {
    levelSize *= breadth;
    total += levelSize;
  }
  return total;
}

/** 1-based index of the first member at `level` (breadth-first order). */
export function firstMemberIndexOfLevel(breadth: number, level: number): number {
  let index = 1;
  let levelSize = 1;
  for (let l = 1; l < level; l += 1) {
    levelSize *= breadth;
    index += levelSize;
  }
  return index;
}

function memberEmail(index: number): string {
  return `miembro-${String(index).padStart(4, "0")}${DEMO_DOMAIN}`;
}

function demoFullName(index: number): string {
  const first = FIRST_NAMES[(index - 1) % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor((index - 1) / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

/** 16 chars from the unambiguous base32 alphabet; printed, never persisted. */
function generatePassword(): string {
  const bytes = randomBytes(16);
  return Array.from(bytes, (byte) => BASE32_ALPHABET[byte % BASE32_ALPHABET.length]).join("");
}

function round2(value: number): string {
  return value.toFixed(2);
}

interface DemoMemberRow {
  id: string;
  email: string;
  path: string;
  depth: number;
}

interface CycleRow {
  id: string;
  periodKey: string;
  startsAt: Date;
  endsAt: Date;
}

interface DemoMethodRow {
  code: string;
  id: string;
}

// Payload shapes mirror the `AS t(...)` column lists below (jsonb_to_recordset
// matches JSON keys against those names, so they are snake_case on purpose).
interface ReportDraft {
  id: string;
  user_id: string;
  amount: string;
  method: string;
  method_id: string;
  reference: string | null;
  paid_at: string;
  reported_at: string;
  proof_key: string | null;
  status: "APPROVED" | "PENDING" | "REJECTED";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  snapshot_depth: number;
  snapshot_path: string;
}

interface ObligationDraft {
  user_id: string;
  status: "FULFILLED" | "PENDING" | "MISSED";
  expected: string;
  report_id: string | null;
}

interface FileDraft {
  key: string;
  owner_id: string;
  mime: string;
  size_bytes: number;
}

export async function seedDemo(
  client: PrismaClient = new PrismaClient(),
  options: DemoOptions = { ...DEMO_PRESET_SPEC, force: false },
  log: (message: string) => void = (message) => console.log(message),
): Promise<void> {
  try {
    await runDemoSeed(client, options, log);
  } finally {
    await client.$disconnect();
  }
}

async function runDemoSeed(
  client: PrismaClient,
  options: DemoOptions,
  log: (message: string) => void,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed:demo refuses to run with NODE_ENV=production: the demo password is printed " +
        "in clear text and the dataset is fabricated. There is no override flag on purpose.",
    );
  }

  const rng = mulberry32(DEMO_RANDOM_SEED);

  // --- Guard: existing non-demo data ----------------------------------------
  // The bootstrap root (seed:root) is not "foreign": the intended fresh flow is
  // `db:migrate && seed:root && seed:demo`, and the demo reuses that root. Any
  // OTHER non-demo account (invited member, admin) demands --force.
  const [totals] = await client.$queryRaw<Array<{ demo: number; foreign: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE email::text LIKE ${"%" + DEMO_DOMAIN}) AS demo,
      (SELECT COUNT(*)::int FROM users
        WHERE email::text NOT LIKE ${"%" + DEMO_DOMAIN}
          AND NOT (sponsor_id IS NULL AND role = 'ROOT')) AS foreign
  `;
  if (totals.foreign > 0 && !options.force) {
    throw new Error(
      `The database already holds ${totals.foreign} non-demo accounts besides the root. ` +
        `seed:demo adds ~${demoTreeSize(options.breadth, options.depth).toLocaleString("en-US")} ` +
        "demo users on top; re-run with --force if that is intended (demo rows use @demo.local emails).",
    );
  }

  // --- F1 prerequisites, reused (not duplicated) ----------------------------
  await seedSettings(client);
  await seedPaymentMethods(client);
  await seedCurrentCycle(client);

  const settingsRows = await client.$queryRaw<Array<{ key: string; value: unknown }>>`
    SELECT key, value FROM settings
    WHERE key IN (
      'general.timezone', 'payments.week_start_day', 'payments.grace_hours',
      'payments.frequency', 'payments.expected_amount', 'payments.currency'
    )
  `;
  const byKey = new Map(settingsRows.map((row) => [row.key, row.value]));
  const timezone = typeof byKey.get("general.timezone") === "string"
    ? (byKey.get("general.timezone") as string)
    : "America/Caracas";
  const cycleInput = {
    now: new Date(),
    timezone,
    weekStartDay: Number(byKey.get("payments.week_start_day") ?? 1),
    graceHours: Number(byKey.get("payments.grace_hours") ?? 48),
    frequency: String(byKey.get("payments.frequency") ?? "WEEKLY") as CycleFrequency,
  };
  const expectedAmount = byKey.has("payments.expected_amount")
    ? round2(Number(byKey.get("payments.expected_amount")))
    : EXPECTED_AMOUNT_FALLBACK;
  const currency = typeof byKey.get("payments.currency") === "string"
    ? (byKey.get("payments.currency") as string)
    : "USD";

  // --- Member root: create only when none exists -----------------------------
  // The system ROOT seeded by `seed:root` is intentionally NOT reused: it is
  // the developer account and lives outside the referral tree. Demo members
  // need the single member root, which is an ADMIN when this seed creates it.
  const existingRoot = await client.$queryRaw<Array<{ id: string; email: string }>>`
    SELECT id, email::text AS email
    FROM users
    WHERE sponsor_id IS NULL AND role <> 'ROOT'
    LIMIT 1
  `;
  let rootId: string;
  let rootPassword: string | null = null;
  let rootEmail: string;
  if (existingRoot.length > 0) {
    rootId = existingRoot[0].id;
    rootEmail = existingRoot[0].email;
    log(`· root: reusing the existing one (${rootEmail}); its password is unchanged`);
  } else {
    rootEmail = `root${DEMO_DOMAIN}`;
    rootPassword = generatePassword();
    const inserted = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO users (public_code, sponsor_id, role, email, password_hash, full_name, status)
      VALUES (
        ${derivePublicCode(rootEmail)}, NULL, 'ADMIN', ${rootEmail}::citext,
        ${await hashPassword(rootPassword)}, ${"Administrador demo"}, 'ACTIVE'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) throw new Error("root insert lost a race; re-run seed:demo");
    rootId = inserted[0].id;
    log(`· root: created (${rootEmail})`);
  }

  // --- Tree: level by level, breadth children per node ----------------------
  const memberPassword = generatePassword();
  const memberPasswordHash = await hashPassword(memberPassword);
  // Printed credentials must be TRUE: the password below only reaches the
  // database for members this run actually inserts, so the count before/after
  // tells us whether printing it would be honest (a re-run keeps the original
  // hash — ON CONFLICT DO NOTHING — and the generated password would be a lie).
  const [before] = await client.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM users WHERE email::text LIKE ${"%" + DEMO_DOMAIN}
  `;
  let parentIds: string[] = [rootId];
  let createdMembers = 0;

  for (let level = 1; level <= options.depth; level += 1) {
    const rows = parentIds.flatMap((parentId) =>
      Array.from({ length: options.breadth }, () => {
        createdMembers += 1;
        const email = memberEmail(createdMembers);
        return {
          public_code: derivePublicCode(email),
          sponsor_id: parentId,
          email,
          full_name: demoFullName(createdMembers),
        };
      }),
    );
    const emails = rows.map((row) => row.email);

    await client.$executeRaw`
      INSERT INTO users (public_code, sponsor_id, role, email, password_hash, full_name, status)
      SELECT t.public_code, t.sponsor_id::uuid, 'MEMBER'::user_role, t.email::citext,
             ${memberPasswordHash}, t.full_name, 'ACTIVE'::user_status
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS t(public_code text, sponsor_id text, email text, full_name text)
      ON CONFLICT DO NOTHING
    `;

    // The tree trigger derives id/path/depth; read the ids back to build the
    // next level. Re-runs find the same rows and reuse their ids.
    const levelRows = await client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE email::text = ANY(${emails}::text[])
    `;
    if (levelRows.length !== emails.length) {
      throw new Error(
        `level ${level}: expected ${emails.length} users after insert, found ${levelRows.length}`,
      );
    }
    parentIds = levelRows.map((row) => row.id);
    log(`· tree: level ${level} — ${levelRows.length} users`);
  }

  const [after] = await client.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM users WHERE email::text LIKE ${"%" + DEMO_DOMAIN}
  `;
  const membersCreatedNow = after.n - before.n;

  // --- Past cycles ----------------------------------------------------------
  const pastBounds: CycleBounds[] = [];
  let cursor = computeCycleBounds(cycleInput);
  for (let index = 0; index < options.weeks; index += 1) {
    cursor = computeCycleBounds({ ...cycleInput, now: new Date(cursor.startsAt.getTime() - 1) });
    pastBounds.push(cursor);
  }
  pastBounds.reverse(); // oldest first

  const pastCycles: CycleRow[] = [];
  for (const bounds of pastBounds) {
    const inserted = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO payment_cycles (period_key, starts_at, ends_at, due_at, status)
      VALUES (${bounds.periodKey}, ${bounds.startsAt}, ${bounds.endsAt}, ${bounds.dueAt}, 'CLOSED')
      ON CONFLICT (period_key) DO NOTHING
      RETURNING id
    `;
    const id = inserted.length > 0
      ? inserted[0].id
      : (await client.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM payment_cycles WHERE period_key = ${bounds.periodKey}
        `)[0]?.id;
    if (id === undefined) throw new Error(`cycle ${bounds.periodKey} vanished after upsert`);
    pastCycles.push({ id, periodKey: bounds.periodKey, startsAt: bounds.startsAt, endsAt: bounds.endsAt });
  }
  log(`· cycles: ${pastCycles.length} past weeks ensured (CLOSED)`);

  // --- Reports, obligations and receipts for the past cycles ----------------
  const members = await client.$queryRaw<DemoMemberRow[]>`
    SELECT id, email::text AS email, path::text AS path, depth
    FROM users
    WHERE email::text LIKE ${"%" + DEMO_DOMAIN} AND role = 'MEMBER'
    ORDER BY email
  `;
  const methods = await client.$queryRaw<DemoMethodRow[]>`
    SELECT code::text AS code, id FROM payment_methods WHERE is_active
  `;
  if (methods.length === 0) throw new Error("no active payment methods; run pnpm seed:root first");
  const methodByCode = new Map(methods.map((row) => [row.code, row.id]));

  const [existingReports] = await client.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM payment_reports r JOIN users u ON u.id = r.user_id
    WHERE u.email::text LIKE ${"%" + DEMO_DOMAIN}
  `;

  let totalsSeen = { reports: 0, approved: 0, pending: 0, rejected: 0, receipts: 0, obligations: 0 };

  if (existingReports.n > 0) {
    log(`· reports: ${existingReports.n} already present — skipping generation (re-run)`);
  } else {
    for (const cycle of pastCycles) {
      const reports: ReportDraft[] = [];
      const obligations: ObligationDraft[] = [];
      const files: FileDraft[] = [];

      for (const member of members) {
        const fulfils = rng() < COMPLIANCE_RATE;
        const tailRoll = fulfils ? 0 : rng();
        const status: ReportDraft["status"] | null = fulfils
          ? "APPROVED"
          : tailRoll < PENDING_SHARE_OF_TAIL
            ? "PENDING"
            : tailRoll < PENDING_SHARE_OF_TAIL + REJECTED_SHARE_OF_TAIL
              ? "REJECTED"
              : null;

        if (status === null) {
          obligations.push({ user_id: member.id, status: "MISSED", expected: expectedAmount, report_id: null });
          continue;
        }

        const reportId = randomUUID();
        const amount = round2(5 + rng() * 20);
        const method = METHOD_CODES[Math.floor(rng() * METHOD_CODES.length)];
        const methodId = methodByCode.get(method) ?? null;
        const paidAt = new Date(cycle.startsAt.getTime() + rng() * 5 * MS_PER_DAY);
        const reportedAt = new Date(Math.min(
          paidAt.getTime() + rng() * 20 * 3_600_000,
          cycle.endsAt.getTime() - 3_600_000,
        ));
        const reviewedAt = status === "PENDING"
          ? null
          : new Date(Math.min(reportedAt.getTime() + (2 + rng() * 46) * 3_600_000, cycle.endsAt.getTime()));

        const wantsReceipt = status === "APPROVED" && rng() < RECEIPT_RATE;
        const proofKey = wantsReceipt ? `demo/proofs/${reportId}.jpg` : null;
        if (proofKey !== null) {
          files.push({
            key: proofKey,
            owner_id: member.id,
            mime: "image/jpeg",
            size_bytes: 80_000 + Math.floor(rng() * 80_000),
          });
        }

        reports.push({
          id: reportId,
          user_id: member.id,
          amount,
          method,
          method_id: methodId ?? "",
          reference: REFERENCE_METHODS.has(method) ? `DEMO-${cycle.periodKey}-${reportId.slice(0, 8)}` : null,
          paid_at: paidAt.toISOString(),
          reported_at: reportedAt.toISOString(),
          proof_key: proofKey,
          status,
          reviewed_by: status === "PENDING" ? null : rootId,
          reviewed_at: reviewedAt === null ? null : reviewedAt.toISOString(),
          review_note: status === "REJECTED" ? "Comprobante ilegible (demo)" : null,
          snapshot_depth: member.depth,
          snapshot_path: member.path,
        });

        obligations.push({
          user_id: member.id,
          status: status === "APPROVED" ? "FULFILLED" : status === "PENDING" ? "PENDING" : "MISSED",
          expected: expectedAmount,
          report_id: status === "APPROVED" ? reportId : null,
        });
      }

      // FK order matters: cycle_obligations.fulfilled_report_id REFERENCES
      // payment_reports(id), so reports must land first. Files carry no FK
      // from reports (proof_key is validated at the app layer), but they are
      // written first anyway so the receipt metadata exists when a human
      // inspects the cycle right after the run.
      if (files.length > 0) {
        await client.$executeRaw`
          INSERT INTO files (key, owner_id, mime, size_bytes, checksum)
          SELECT t.key, t.owner_id::uuid, t.mime, t.size_bytes::bigint, NULL
          FROM jsonb_to_recordset(${JSON.stringify(files)}::jsonb)
            AS t(key text, owner_id text, mime text, size_bytes int)
          ON CONFLICT (key) DO NOTHING
        `;
      }

      if (reports.length > 0) {
        await client.$executeRaw`
          INSERT INTO payment_reports (
            id, user_id, cycle_id, amount, currency, method, method_id, reference,
            paid_at, reported_at, proof_key, status, reviewed_by, reviewed_at,
            review_note, snapshot_depth, snapshot_path
          )
          SELECT
            t.id::uuid, t.user_id::uuid, ${cycle.id}::uuid, t.amount::numeric, ${currency},
            t.method::payment_method, NULLIF(t.method_id, '')::uuid, t.reference,
            t.paid_at::timestamptz, t.reported_at::timestamptz, t.proof_key,
            t.status::report_status, NULLIF(t.reviewed_by, '')::uuid, t.reviewed_at::timestamptz,
            t.review_note, t.snapshot_depth::int, t.snapshot_path::ltree
          FROM jsonb_to_recordset(${JSON.stringify(reports)}::jsonb)
            AS t(
              id text, user_id text, amount text, method text, method_id text, reference text,
              paid_at text, reported_at text, proof_key text, status text, reviewed_by text,
              reviewed_at text, review_note text, snapshot_depth int, snapshot_path text
            )
          ON CONFLICT DO NOTHING
        `;
      }

      await client.$executeRaw`
        INSERT INTO cycle_obligations (cycle_id, user_id, status, expected_amount, fulfilled_report_id)
        SELECT ${cycle.id}::uuid, t.user_id::uuid, t.status, t.expected::numeric, t.report_id::uuid
        FROM jsonb_to_recordset(${JSON.stringify(obligations)}::jsonb)
          AS t(user_id text, status text, expected text, report_id text)
        ON CONFLICT (cycle_id, user_id) DO NOTHING
      `;

      const approved = reports.filter((report) => report.status === "APPROVED").length;
      const pending = reports.filter((report) => report.status === "PENDING").length;
      const rejected = reports.filter((report) => report.status === "REJECTED").length;
      totalsSeen = {
        reports: totalsSeen.reports + reports.length,
        approved: totalsSeen.approved + approved,
        pending: totalsSeen.pending + pending,
        rejected: totalsSeen.rejected + rejected,
        receipts: totalsSeen.receipts + files.length,
        obligations: totalsSeen.obligations + obligations.length,
      };
      log(`· ${cycle.periodKey}: ${reports.length} reports (${approved}/${pending}/${rejected}), ${obligations.length} obligations`);
    }
  }

  // --- Refresh the dashboard MV so the demo shows data immediately ----------
  try {
    await client.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_weekly`;
    log("· mv_payment_weekly: refreshed");
  } catch {
    log("· mv_payment_weekly: not refreshable yet (run `pnpm db:migrate` first?)");
  }

  // --- Summary and credentials ----------------------------------------------
  const totalUsers = demoTreeSize(options.breadth, options.depth);
  log("");
  log("===== seed:demo complete =====");
  log(`tree: ${options.breadth} x ${options.depth} → ${totalUsers.toLocaleString("en-US")} users (1 root + ${(totalUsers - 1).toLocaleString("en-US")} members)`);
  log(`cycles: ${pastCycles.length} past (CLOSED) + the current OPEN one`);
  if (existingReports.n === 0) {
    log(
      `reports: ${totalsSeen.reports.toLocaleString("en-US")} ` +
        `(approved ${totalsSeen.approved.toLocaleString("en-US")} · pending ${totalsSeen.pending.toLocaleString("en-US")} · rejected ${totalsSeen.rejected.toLocaleString("en-US")}) · ` +
        `receipts: ${totalsSeen.receipts.toLocaleString("en-US")} · obligations: ${totalsSeen.obligations.toLocaleString("en-US")}`,
    );
  }
  log("");
  log("DEMO CREDENTIALS — never reuse these anywhere real:");
  if (rootPassword !== null) {
    log(`  ROOT      ${rootEmail} / ${rootPassword}`);
  } else {
    log(`  ROOT      ${rootEmail} (pre-existing; password unchanged — see pnpm seed:root)`);
  }
  const levels = Math.min(3, options.depth);
  if (membersCreatedNow > 0) {
    for (let level = 1; level <= levels; level += 1) {
      log(`  LEVEL ${level}   ${memberEmail(firstMemberIndexOfLevel(options.breadth, level))} / ${memberPassword}`);
    }
    const expectedMembers = totalUsers - 1;
    if (membersCreatedNow !== expectedMembers) {
      log(
        `  (${membersCreatedNow.toLocaleString("en-US")} of ${expectedMembers.toLocaleString("en-US")} members were ` +
          "created by THIS run — the password above applies only to those; earlier members keep theirs)",
      );
    }
  } else if (options.depth > 0) {
    log("  MEMBERS   already existed — their password is the one printed by the run that created them");
  }
  if (options.depth === 0) log("  (no members: depth 0 is just the root)");
  log("(members share one demo password; receipts are metadata-only — no storage objects)");
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(DEMO_USAGE);
  } else {
    let options: DemoOptions | undefined;
    try {
      options = parseDemoArgs(argv);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
    if (options !== undefined) {
      seedDemo(new PrismaClient(), options).catch((error: unknown) => {
        console.error("\nseed:demo failed:");
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    }
  }
}
