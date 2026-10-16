// =============================================================================
// tests/password.test.ts — Argon2id verify + the timing equaliser (WU4).
//
// tests/set-password.test.ts covers `hashPassword` through the seed/admin
// flow. The two functions exercised here are the ones F2 login depends on:
//   * `verifyPassword`, against a REAL hash produced by `hashPassword` (same
//     ARGON2_OPTIONS as production), and
//   * `burnVerificationTime`, which must spend time and NEVER throw — a throw
//     on the unknown-email path would itself be the timing signal it removes.
// =============================================================================

import { beforeAll, describe, expect, it } from "vitest";

import { burnVerificationTime, hashPassword, verifyPassword } from "../lib/password";

const PLAINTEXT = "clave-de-prueba-123";
let storedHash: string;

beforeAll(async () => {
  storedHash = await hashPassword(PLAINTEXT);
});

describe("hashPassword / verifyPassword", () => {
  it("produces a PHC string carrying the argon2id parameters", () => {
    expect(storedHash).toMatch(/^\$argon2id\$/);
    // The parameters travel in the hash, so raising them later does not
    // invalidate existing rows.
    expect(storedHash).toContain("m=19456");
  });

  it("verifies the correct password", async () => {
    await expect(verifyPassword(storedHash, PLAINTEXT)).resolves.toBe(true);
  });

  it("rejects a wrong password without throwing", async () => {
    await expect(verifyPassword(storedHash, "otra-clave")).resolves.toBe(false);
  });
});

describe("burnVerificationTime", () => {
  it("resolves for any input and never throws (timing equaliser)", async () => {
    await expect(burnVerificationTime("")).resolves.toBeUndefined();
    await expect(burnVerificationTime("lo-que-sea")).resolves.toBeUndefined();
  });

  it("can be called repeatedly (the dummy hash is cached)", async () => {
    await burnVerificationTime("uno");
    await burnVerificationTime("dos");
    await burnVerificationTime("tres");
  });
});
