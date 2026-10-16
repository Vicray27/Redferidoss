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
 * The per-IP registration throttle. The WINDOW lives here; the effective CAP
 * comes from `security.register_rate_limit_per_hour_per_ip`, read per request
 * by the route and passed to `attempt()` (§18.3, F8). The constructor `max`
 * below only satisfies the API for hypothetical callers that do not pass an
 * override — no production caller relies on it.
 */
export const registerThrottle = createThrottle({ windowMs: 60 * 60 * 1000, max: 20 });

/**
 * 60 resolution requests per IP per 10 minutes. The public invite page hits
 * this once per visit; the cap only exists to stop token guessing at speed.
 */
export const publicInviteThrottle = createThrottle({ windowMs: 10 * 60 * 1000, max: 60 });
