// =============================================================================
// lib/auth/session.ts — stateless session tokens (Edge-safe).
//
// A session is a signed JWT in an httpOnly cookie. This module is imported by
// `middleware.ts`, which runs on the Edge Runtime, so it deliberately depends on
// NOTHING except `jose` and `zod`: no Prisma, no `pg`, no `next/*`. Every check
// that needs a database happens in `lib/auth/require.ts`, on the server.
//
// D16 records why this is a hand-rolled token and not Auth.js v5.
//
// ---------------------------------------------------------------------------
// The secret is read at RUNTIME, through a computed key
// ---------------------------------------------------------------------------
// Next.js inlines *statically analysable* `process.env.FOO` member expressions
// at build time, which would bake AUTH_SECRET into the bundle and force it to
// exist during `docker build`. The framework documents that a dynamic lookup
// (`process.env[name]`) is NOT inlined:
//   https://nextjs.org/docs/app/building-your-application/configuring/environment-variables
// The stack injects AUTH_SECRET at deploy time and one image is promoted across
// environments, so runtime is the only correct answer. The name is therefore
// resolved through a variable on purpose — do not "simplify" it to
// `process.env.AUTH_SECRET`.
//
// Read on CALL, not at module scope: a value captured at import time is frozen
// for the life of the process and cannot be rotated without a redeploy.
// =============================================================================

import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

import type { UserRole } from "../users";

/** Cookie name. Prefixed by product so it cannot collide on a shared domain. */
export const SESSION_COOKIE = "red_session";

/** §9 session lifetime. Short enough that a stolen cookie has a bounded life. */
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

const JWT_ISSUER = "red-referidos";
const JWT_AUDIENCE = "red-referidos:web";

/**
 * Minimum acceptable secret length.
 *
 * HS256 strength is the key length, so a short AUTH_SECRET is a weak MAC, not a
 * weak password. 32 characters of base64 is the `openssl rand -base64 32`
 * output the .env.example tells operators to generate.
 */
export const MIN_AUTH_SECRET_LENGTH = 32;

/** Placeholder shipped in .env.example. Deploying it must fail loudly. */
const KNOWN_PLACEHOLDER = "change-me";

/** Thrown when AUTH_SECRET is absent, too short, or still the example value. */
export class AuthSecretError extends Error {
  constructor(reason: string) {
    super(
      `AUTH_SECRET is unusable: ${reason}. ` +
        `Generate one with "openssl rand -base64 32" and set it in the stack ` +
        `environment. Sessions are REFUSED rather than signed with a weak key.`,
    );
    this.name = "AuthSecretError";
  }
}

/**
 * Read AUTH_SECRET from the runtime environment.
 *
 * Throws rather than falling back to a default. A silent fallback would be the
 * single worst outcome here: the app would appear to work, sessions would be
 * signed with a key that is public in the repository, and anyone could forge a
 * ROOT token.
 */
export function readAuthSecret(): Uint8Array {
  // Computed access on purpose: see the header note on build-time inlining.
  const name = "AUTH_SECRET";
  const raw = process.env[name];

  if (!raw || raw.trim() === "") {
    throw new AuthSecretError("it is not set");
  }
  if (raw.includes(KNOWN_PLACEHOLDER)) {
    throw new AuthSecretError("it is still the .env.example placeholder");
  }
  if (raw.trim().length < MIN_AUTH_SECRET_LENGTH) {
    throw new AuthSecretError(
      `it is shorter than ${MIN_AUTH_SECRET_LENGTH} characters (got ${raw.trim().length})`,
    );
  }
  return new TextEncoder().encode(raw.trim());
}

/** The minimal session a routing decision needs. */
export interface SessionPayload {
  userId: string;
  role: UserRole;
  /** The `/r/{public_code}` handle, so pages never re-query for it. */
  publicCode: string;
  fullName: string;
}

/**
 * Shape of the token's custom claims.
 *
 * Parsed with Zod even though the token is already signed. A signature proves
 * WE wrote the token; it does not prove the payload has the fields we expect
 * after a schema change or a future bug. Anything that fails this parse is
 * treated as "no session", never as a partially trusted one.
 */
const claimsSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["ROOT", "ADMIN", "MEMBER"]),
  publicCode: z.string().min(1),
  fullName: z.string().min(1),
});

export interface SignOptions {
  /** Override the lifetime (tests). */
  ttlSeconds?: number;
  /** Injectable clock so expiry is testable without waiting 8 hours. */
  now?: () => number;
}

/** Mint a signed session token for a user. */
export async function signSessionToken(
  payload: SessionPayload,
  options: SignOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return new SignJWT({
    role: payload.role,
    pc: payload.publicCode,
    name: payload.fullName,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now())
    .setExpirationTime(now() + ttl)
    .sign(readAuthSecret());
}

export interface VerifyOptions {
  /** Injectable clock so expiry is testable without waiting 8 hours. */
  now?: () => number;
}

/**
 * Verify a token and return its payload, or null when it is not usable.
 *
 * Returns null — never throws — for every rejection: bad signature, wrong
 * issuer or audience, expired, malformed, or a payload that fails the Zod
 * shape. Callers treat null as "anonymous", so an exception here would turn a
 * stale cookie into a 500 instead of a login redirect.
 *
 * `jose` verifies `exp` itself; the explicit check below is belt-and-braces for
 * the injected-clock case and documents the rule at the call site.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  options: VerifyOptions = {},
): Promise<SessionPayload | null> {
  if (!token) return null;

  let claims: unknown;
  try {
    const result = await jwtVerify(token, readAuthSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
      ...(options.now ? { currentDate: new Date(options.now() * 1000) } : {}),
    });
    claims = result.payload;
  } catch {
    // Throws on: bad/missing secret, signature mismatch, expiry, issuer,
    // audience or algorithm mismatch. All of them mean "no session".
    return null;
  }

  const parsed = claimsSchema.safeParse({
    userId: (claims as { sub?: unknown }).sub,
    role: (claims as { role?: unknown }).role,
    publicCode: (claims as { pc?: unknown }).pc,
    fullName: (claims as { name?: unknown }).name,
  });

  return parsed.success ? parsed.data : null;
}

/**
 * Cookie attributes for the session cookie.
 *
 * `httpOnly` keeps the token away from JavaScript, so an XSS bug cannot read
 * it. `sameSite: "lax"` still sends it on top-level GET navigations (so a
 * bookmark to /admin works) while blocking cross-site POSTs, which is what
 * makes the CSRF story simple. `secure` is tied to production so the local
 * http://localhost flow still works.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
} as const;