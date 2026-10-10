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

/**
 * Spend argon2 time on a throwaway hash so a failed lookup costs the same as a
 * failed comparison.
 *
 * Without this, "no such user" returns in microseconds (there is nothing to
 * verify) while "wrong password" takes ~40 ms, and that gap tells an attacker
 * which addresses have accounts — even though both branches return the same
 * message. `lib/auth/login.ts` calls this on the unknown-email path.
 *
 * The dummy hash is generated lazily and cached: hashing costs real time too,
 * and paying it on every request would make the defence more expensive than the
 * thing it defends. It is hashed from a constant that is never a credential, so
 * it can never collide with a real account.
 */
let dummyHashPromise: Promise<string> | null = null;

const DUMMY_PLAINTEXT = "red-referidos-timing-equaliser";

export function burnVerificationTime(plain: string): Promise<void> {
  dummyHashPromise ??= hashPassword(DUMMY_PLAINTEXT);
  return dummyHashPromise.then(async (dummyHash) => {
    // The result is deliberately ignored: this call exists for its cost.
    // A throw here would surface as a 500 on the unknown-email path, which is
    // exactly the timing signal the defence removes.
    await verifyPassword(dummyHash, plain).catch(() => false);
  });
}