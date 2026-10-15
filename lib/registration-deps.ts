// =============================================================================
// lib/registration-deps.ts — wires registerUser() and the public throttles to
// the real implementations, the same split as lib/auth/deps.ts.
//
// `invitationsFor(tx)` is the important line: it builds the invitations
// service over the CALLER's transaction, so quota reads and the consumption of
// the single-use token happen in the same atomic unit as the INSERT (§8.4).
// Building it over `prisma` instead would quietly move those reads outside the
// transaction — the A3 bug, reintroduced by one wiring mistake.
// =============================================================================

import { prisma } from "./db";
import { createInvitationsService } from "./invitations";
import { hashPassword } from "./password";
import { randomPublicCode, type RegistrationDeps } from "./registration";
import { settings } from "./settings";
import { createThrottle } from "./throttle";

/** The real self-registration dependencies. */
export const registrationDeps: RegistrationDeps = {
  db: prisma,
  settings,
  invitationsFor: (tx) => createInvitationsService(tx, settings),
  hashPassword: (plain) => hashPassword(plain),
  generatePublicCode: () => randomPublicCode(),
};

/**
 * 20 registrations per IP per hour. Generous for a household or a shared
 * connection registering a whole referral line; far below what scripted abuse
 * needs to be worthwhile.
 */
export const registerThrottle = createThrottle({ windowMs: 60 * 60 * 1000, max: 20 });

/**
 * 60 resolution requests per IP per 10 minutes. The public invite page hits
 * this once per visit; the cap only exists to stop token guessing at speed.
 */
export const publicInviteThrottle = createThrottle({ windowMs: 10 * 60 * 1000, max: 60 });
