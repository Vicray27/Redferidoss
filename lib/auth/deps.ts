// =============================================================================
// lib/auth/deps.ts — wires `authenticate()` to the real implementations.
//
// Kept out of lib/auth/actions.ts on purpose: a `"use server"` module may only
// export async functions, so the dependency object cannot live there. This
// file is also the single place where the login path touches Prisma, argon2
// and the signer, which makes the boundary easy to audit.
// =============================================================================

import { prisma } from "../db";
import { burnVerificationTime, verifyPassword } from "../password";
import { users } from "../users";

import type { LoginDeps } from "./login";
import { createLoginRateLimiter } from "./rate-limit";
import { signSessionToken } from "./session";

/** The real credential-check dependencies. */
export const loginDeps: LoginDeps = {
  findUserByEmail: (email) => users.findByEmail(email),
  verifyPassword,
  burn: burnVerificationTime,
  issueToken: (payload) => signSessionToken(payload),
};

/** The real failed-attempt throttle, over the `rate_limits` table from §5.9. */
export const loginRateLimiter = createLoginRateLimiter(prisma);