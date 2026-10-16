// =============================================================================
// e2e/global-teardown.ts — drop the throwaway database created for this run.
//
// The URL comes from the marker file: teardown may run in a different process
// than the config that minted it. DROP ... WITH (FORCE) closes any connection
// the dev server still holds.
// =============================================================================

import { clearDbMarker, dropE2eDatabase, readDbMarker } from "./db-target";

export default async function globalTeardown(): Promise<void> {
  const dbUrl = readDbMarker();
  if (!dbUrl) return;

  console.log(`[e2e] dropping throwaway database: ${dbUrl}`);
  try {
    await dropE2eDatabase(dbUrl);
  } finally {
    clearDbMarker();
  }
}
