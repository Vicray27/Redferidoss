import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SETTINGS_CATALOG, SETTINGS_KEYS_READ_BY_SQL } from "../lib/settings-catalog";

/**
 * Drift gate seed <-> 0001_init, in the same spirit as
 * scripts/check-schema-drift.mjs: the SQL migration is the authority, and the
 * seed catalog must agree with it. The failure this catches is real — a
 * function in the SQL that reads a setting the seed never inserted returns NULL
 * and silently degrades a business rule (a NULL quota means "no limit").
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATION = readFileSync(
  path.join(ROOT, "prisma", "migrations", "0001_init", "migration.sql"),
  "utf8",
);

const catalogKeys = new Set(SETTINGS_CATALOG.map((entry) => entry.key));

const KEY_QUOTED = /'(referral|payments|general|visibility|security)\.[a-z_]+'/g;
const KEY_BARE = /\b(referral|payments|general|visibility|security)\.[a-z_]+\b/g;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Keys read at RUNTIME by a SQL function. Comments are stripped first: a key
 * mentioned in a comment is a documented dependency, not an executable read,
 * and conflating the two would hide which failure mode applies.
 */
function keysReadAtRuntime(): string[] {
  const executable = stripSqlComments(MIGRATION);
  return [
    ...new Set([...executable.matchAll(KEY_QUOTED)].map((match) => match[0].slice(1, -1))),
  ];
}

/** Keys the DDL depends on but never executes against (e.g. the D4 index). */
function keysDocumentedInComments(): string[] {
  const atRuntime = keysReadAtRuntime();
  const commented = MIGRATION.replace(/^(?!\s*--).*$/gm, "");
  return [...new Set([...commented.matchAll(KEY_BARE)].map((match) => match[0]))].filter(
    (key) => !atRuntime.includes(key),
  );
}

/** Values of the setting_type enum declared by the migration. */
function settingTypeValues(): string[] {
  const block = MIGRATION.match(
    /CREATE TYPE setting_type AS ENUM\s*\(([\s\S]*?)\)\s*;/,
  )?.[1];
  if (!block) return [];
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("§6 catalog vs 0001_init", () => {
  it("declares every settings key the SQL reads at runtime", () => {
    const read = keysReadAtRuntime();
    expect(read.sort()).toEqual([
      "referral.count_pending_in_limit",
      "referral.max_depth",
      "referral.max_direct_referrals",
    ]);

    expect(read.filter((key) => !catalogKeys.has(key))).toEqual([]);
  });

  it("declares the settings the DDL itself bakes in (D4 partial unique index)", () => {
    const documented = keysDocumentedInComments();
    expect(documented).toEqual(["payments.max_reports_per_cycle"]);
    expect(documented.filter((key) => !catalogKeys.has(key))).toEqual([]);
  });

  it("the documented read-by-SQL list matches the migration exactly", () => {
    const derived = [...keysReadAtRuntime(), ...keysDocumentedInComments()].sort();
    expect([...SETTINGS_KEYS_READ_BY_SQL].sort()).toEqual(derived);
  });

  it("uses only setting_type values the migration creates", () => {
    const allowed = settingTypeValues();
    expect(allowed.length).toBeGreaterThan(0);

    const bad = SETTINGS_CATALOG.filter((entry) => !allowed.includes(entry.type)).map(
      (entry) => `${entry.key}: ${entry.type}`,
    );
    expect(bad).toEqual([]);
  });

  it("uses only editable_by values the user_role enum creates", () => {
    const block = MIGRATION.match(/CREATE TYPE user_role AS ENUM\s*\(([\s\S]*?)\)\s*;/)?.[1] ?? "";
    const roles = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(roles.length).toBeGreaterThan(0);

    const bad = SETTINGS_CATALOG.filter((entry) => !roles.includes(entry.editableBy)).map(
      (entry) => entry.key,
    );
    expect(bad).toEqual([]);
  });
});

describe("§6 catalog shape", () => {
  it("has unique keys", () => {
    expect(catalogKeys.size).toBe(SETTINGS_CATALOG.length);
  });

  it("keeps group_name equal to the key prefix", () => {
    const bad = SETTINGS_CATALOG.filter((entry) => !entry.key.startsWith(`${entry.groupName}.`)).map(
      (entry) => entry.key,
    );
    expect(bad).toEqual([]);
  });

  it("covers the five §6 groups", () => {
    const groups = [...new Set(SETTINGS_CATALOG.map((entry) => entry.groupName))].sort();
    expect(groups).toEqual(["general", "payments", "referral", "security", "visibility"]);
  });

  it("ships the complete §6 catalog (40 keys)", () => {
    // A hard count makes an accidental deletion fail loudly instead of
    // silently shrinking the business-parameter surface.
    expect(SETTINGS_CATALOG).toHaveLength(40);
  });

  it("stores ENUM keys as JSON scalars inside their declared options", () => {
    for (const entry of SETTINGS_CATALOG.filter((e) => e.type === "ENUM")) {
      expect(entry.options, entry.key).toBeDefined();
      expect(entry.options, entry.key).toContain(entry.value);
    }
  });

  it("stores every value as a JSONB scalar (functions read them with #>> '{}')", () => {
    for (const entry of SETTINGS_CATALOG) {
      const isScalarOrArray =
        typeof entry.value === "string" ||
        typeof entry.value === "boolean" ||
        typeof entry.value === "number" ||
        Array.isArray(entry.value);
      expect(isScalarOrArray, entry.key).toBe(true);
    }
  });

  it("marks exactly one key as public (the brand name, per §5.7)", () => {
    const publicKeys = SETTINGS_CATALOG.filter((entry) => entry.isPublic).map((e) => e.key);
    expect(publicKeys).toEqual(["general.app_name"]);
  });

  it("keeps every key editable by an admin, as §6 requires", () => {
    const bad = SETTINGS_CATALOG.filter((entry) => entry.editableBy === "MEMBER").map(
      (entry) => entry.key,
    );
    expect(bad).toEqual([]);
  });

  it("carries the label and description the /admin screen renders", () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(entry.label.length, entry.key).toBeGreaterThan(0);
      expect(entry.description.length, entry.key).toBeGreaterThan(0);
    }
  });
});

describe("§6 values the rest of the system depends on", () => {
  const valueOf = (key: string) => SETTINGS_CATALOG.find((entry) => entry.key === key)?.value;

  it("seeds the R2 quota at 12 (A1 changes it to 10 at runtime)", () => {
    expect(valueOf("referral.max_direct_referrals")).toBe(12);
  });

  it("seeds max_depth at 0 (unlimited, R4)", () => {
    expect(valueOf("referral.max_depth")).toBe(0);
  });

  it("counts pending invites against the quota by default (R3)", () => {
    expect(valueOf("referral.count_pending_in_limit")).toBe(true);
  });

  it("seeds max_reports_per_cycle at 1 so the partial unique index matches R7/D4", () => {
    expect(valueOf("payments.max_reports_per_cycle")).toBe(1);
  });

  it("seeds the R11 cycle configuration used to compute the first cycle", () => {
    expect(valueOf("payments.week_start_day")).toBe(1); // Monday
    expect(valueOf("payments.frequency")).toBe("WEEKLY");
    expect(valueOf("payments.grace_hours")).toBe(48);
    expect(valueOf("general.timezone")).toBe("America/Caracas");
  });

  it("seeds R8 money as a number, never a float literal in the catalog", () => {
    expect(typeof valueOf("payments.expected_amount")).toBe("number");
    expect(valueOf("payments.expected_amount")).toBe(10);
  });

  it("does not require email verification in a project with no mail provider (D7)", () => {
    expect(valueOf("referral.require_email_verification")).toBe(false);
  });
});