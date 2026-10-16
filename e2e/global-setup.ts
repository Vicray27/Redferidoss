// =============================================================================
// e2e/global-setup.ts — provision the throwaway database for one E2E run.
//
// 1. drop a leftover database from a crashed run (marker file),
// 2. CREATE DATABASE referidos_e2e_<stamp> on the same server as .env points
//    to (probe confirmed the role may; D72),
// 3. apply migrations and seed the root user against it,
// 4. on failure, drop what was created so nothing is left behind.
//
// The shared dev database is never touched: DATABASE_URL is overridden for
// every child process.
// =============================================================================

import { execSync } from "node:child_process";

import {
  E2E_ROOT_EMAIL,
  E2E_ROOT_PASSWORD,
  clearDbMarker,
  createE2eDatabase,
  dropE2eDatabase,
  e2eDatabaseUrl,
  readDbMarker,
  writeDbMarker,
} from "./db-target";

function run(command: string, env: NodeJS.ProcessEnv): void {
  console.log(`[e2e] $ ${command}`);
  execSync(command, { stdio: "inherit", env });
}

export default async function globalSetup(): Promise<void> {
  // A marker left behind means a previous run crashed mid-setup: clean it.
  const stale = readDbMarker();
  if (stale) {
    console.warn(`[e2e] dropping leftover database from a previous run (${stale})`);
    await dropE2eDatabase(stale).catch(() => undefined);
    clearDbMarker();
  }

  const dbUrl = e2eDatabaseUrl();
  console.log(`[e2e] creating throwaway database: ${dbUrl}`);
  await createE2eDatabase(dbUrl);
  // Written before the migrations so a failure below still cleans up.
  writeDbMarker(dbUrl);

  try {
    run("pnpm exec prisma migrate deploy", { ...process.env, DATABASE_URL: dbUrl });
    run("pnpm seed:root", {
      ...process.env,
      DATABASE_URL: dbUrl,
      ROOT_EMAIL: E2E_ROOT_EMAIL,
      ROOT_PASSWORD: E2E_ROOT_PASSWORD,
    });
  } catch (error) {
    console.error("[e2e] setup failed — dropping the throwaway database");
    await dropE2eDatabase(dbUrl).catch(() => undefined);
    clearDbMarker();
    throw error;
  }
}
