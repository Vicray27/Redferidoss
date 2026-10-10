// Argon2id password hashing (§ stack: Auth.js Credentials + Argon2id).
//
// `@node-rs/argon2` is used instead of `argon2` because the production image is
// node:24-ALPINE: `argon2` needs node-gyp and a toolchain at install time,
// while `@node-rs/argon2` ships prebuilt N-API binaries, including
// `@node-rs/argon2-linux-x64-musl`. See docs/decisiones.md (D10).
//
// The seed calls `hashPassword`; F2 auth will add `verifyPassword`. Both live
// here so the parameters can never drift between the two call sites.

import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * OWASP-aligned Argon2id parameters (19 MiB, t=2, p=1).
 * Stored PHC string carries them, so raising them later does not invalidate
 * existing hashes.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  algorithm: 2, // 2 = argon2id
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

export function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  return argon2Verify(storedHash, plain, ARGON2_OPTIONS);
}