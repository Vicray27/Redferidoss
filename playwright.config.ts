// =============================================================================
// playwright.config.ts — §16 E2E: the full flow on a throwaway database.
//
// One worker, one journey, one dev server on port 3100 wired to a database
// created per run by e2e/global-setup.ts and dropped by e2e/global-teardown.ts.
// The app's own `.env` still provides the base server; only DATABASE_URL and
// AUTH_SECRET are overridden for the spawned dev server.
//
// NOTE: `next dev` shares `.next/` with the developer's own dev server, so stop
// `pnpm dev` before running `pnpm test:e2e`.
// =============================================================================

import { defineConfig } from "@playwright/test";

import { E2E_BASE_URL, E2E_PORT, e2eAuthSecret, e2eDatabaseUrl } from "./e2e/db-target";

export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    navigationTimeout: 90_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: `pnpm exec next dev -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: e2eDatabaseUrl(),
      AUTH_SECRET: e2eAuthSecret(),
    },
  },
});
