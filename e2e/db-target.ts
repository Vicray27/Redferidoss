// =============================================================================
// e2e/db-target.ts — the throwaway-database contract shared by the Playwright
// config, global setup and global teardown.
//
// The E2E suite must never touch the shared development database, so every run
// creates its own `referidos_e2e_<stamp>` database on the same PostgreSQL
// server, applies the migrations, seeds the root user and drops the database
// when the run finishes (isolation probe: CREATE DATABASE is allowed for the
// `referidos` role — see docs/decisiones.md D72).
//
// All three consumers must agree on ONE database name. Playwright loads the
// config, then runs globalSetup and globalTeardown, but does not guarantee they
// share a process, so the URL is:
//   * computed once per process (module cache), and
//   * persisted in `e2e/.e2e-db-url` by globalSetup, which teardown reads.
// =============================================================================

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

const ROOT = process.cwd();
const MARKER_PATH = path.join(ROOT, "e2e", ".e2e-db-url");
const ENV_PATH = path.join(ROOT, ".env");

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

// Credentials for the throwaway database only — they never leave this run.
export const E2E_ROOT_EMAIL = "root.e2e@example.test";
export const E2E_ROOT_PASSWORD = "e2e-Root-Password-123";
export const E2E_MEMBER_EMAIL = "member.e2e@example.test";
export const E2E_MEMBER_PASSWORD = "e2e-Member-Password-123";
export const E2E_MEMBER_NAME = "Miembro E2E";
export const E2E_REPORT_AMOUNT = "10.00";

/** Minimal `.env` reader (the same file Prisma and Next consume). */
function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const entries: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[match[1]] = value;
  }
  return entries;
}

export function readBaseDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const fromFile = readEnvFile().DATABASE_URL;
  if (fromFile) return fromFile;
  throw new Error(
    "DATABASE_URL is not set (checked the process env and .env): the E2E run needs a reachable PostgreSQL server.",
  );
}

export function withDatabaseName(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Connection string for the admin client: the MAINTENANCE database (the base
 * one from .env, which must exist) — the throwaway name travels in the DDL
 * (`CREATE DATABASE "<name>"`), never in the connection path. The `?schema=`
 * param is meaningless to `pg` and is dropped.
 */
function adminUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${new URL(readBaseDatabaseUrl()).pathname.slice(1)}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

let cachedDbUrl: string | null = null;

/** The throwaway database URL — computed once and reused within the process. */
export function e2eDatabaseUrl(): string {
  if (cachedDbUrl) return cachedDbUrl;
  const name = `referidos_e2e_${Date.now().toString(36)}`;
  cachedDbUrl = withDatabaseName(readBaseDatabaseUrl(), name);
  return cachedDbUrl;
}

let cachedAuthSecret: string | null = null;

/** A fresh session secret per run; sessions never leak across runs. */
export function e2eAuthSecret(): string {
  if (!cachedAuthSecret) {
    cachedAuthSecret = process.env.E2E_AUTH_SECRET ?? randomBytes(32).toString("hex");
    process.env.E2E_AUTH_SECRET = cachedAuthSecret;
  }
  return cachedAuthSecret;
}

export function databaseNameOf(url: string): string {
  return new URL(url).pathname.slice(1);
}

export async function createE2eDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl(url) });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${databaseNameOf(url)}"`);
  } finally {
    await client.end();
  }
}

export async function dropE2eDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl(url) });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseNameOf(url)}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export function writeDbMarker(url: string): void {
  writeFileSync(MARKER_PATH, url, "utf8");
}

export function readDbMarker(): string | null {
  return existsSync(MARKER_PATH) ? readFileSync(MARKER_PATH, "utf8").trim() : null;
}

export function clearDbMarker(): void {
  rmSync(MARKER_PATH, { force: true });
}
