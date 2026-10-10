import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuthSecretError,
  MIN_AUTH_SECRET_LENGTH,
  readAuthSecret,
  SESSION_TTL_SECONDS,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from "../lib/auth/session";

/**
 * No database and no framework: these tests exercise the real `jose` signing
 * path with a real HMAC key, so a token that verifies here would verify in the
 * Edge middleware too.
 *
 * The clock is injected rather than awaited, so expiry is proven without
 * sleeping for 8 hours.
 */

const VALID_SECRET = "s3cret-for-tests-only-not-a-real-deployment-key-0123456789";

const PAYLOAD: SessionPayload = {
  userId: "8f2b5a1e-0000-4000-8000-000000000001",
  role: "ROOT",
  publicCode: "JJGYCMQ1",
  fullName: "Administrador ROOT",
};

const originalSecret = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = VALID_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalSecret;
});

describe("readAuthSecret", () => {
  it("returns the raw bytes of the runtime environment value", () => {
    expect(new TextDecoder().decode(readAuthSecret())).toBe(VALID_SECRET);
  });

  it("refuses to run when AUTH_SECRET is missing, instead of signing with a default", () => {
    delete process.env.AUTH_SECRET;
    // A silent fallback would be the worst possible outcome: the app would look
    // like it worked while anyone holding the public key forged a ROOT token.
    expect(() => readAuthSecret()).toThrow(AuthSecretError);
    expect(() => readAuthSecret()).toThrow(/not set/);
  });

  it("refuses the .env.example placeholder, which is committed to the repository", () => {
    process.env.AUTH_SECRET = "change-me-generate-with-openssl-rand-base64-32";
    expect(() => readAuthSecret()).toThrow(/placeholder/);
  });

  it("refuses a short secret, because HS256 strength IS the key length", () => {
    process.env.AUTH_SECRET = "a".repeat(MIN_AUTH_SECRET_LENGTH - 1);
    expect(() => readAuthSecret()).toThrow(/shorter than/);
  });

  it("accepts a secret of exactly the minimum length", () => {
    process.env.AUTH_SECRET = "a".repeat(MIN_AUTH_SECRET_LENGTH);
    expect(() => readAuthSecret()).not.toThrow();
  });

  it("ignores surrounding whitespace but not an empty value", () => {
    process.env.AUTH_SECRET = `  ${VALID_SECRET}  `;
    expect(new TextDecoder().decode(readAuthSecret())).toBe(VALID_SECRET);

    process.env.AUTH_SECRET = "   ";
    expect(() => readAuthSecret()).toThrow(AuthSecretError);
  });
});

describe("signSessionToken / verifySessionToken", () => {
  it("round-trips every claim the UI needs", async () => {
    const token = await signSessionToken(PAYLOAD);
    await expect(verifySessionToken(token)).resolves.toEqual(PAYLOAD);
  });

  it("round-trips each role", async () => {
    for (const role of ["ROOT", "ADMIN", "MEMBER"] as const) {
      const token = await signSessionToken({ ...PAYLOAD, role });
      await expect(verifySessionToken(token)).resolves.toMatchObject({ role });
    }
  });

  it("rejects a token signed with a DIFFERENT secret", async () => {
    const token = await signSessionToken(PAYLOAD);
    process.env.AUTH_SECRET = "another-completely-different-secret-key-0123456789";
    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signSessionToken(PAYLOAD);
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "ADMIN" }),
    ).toString("base64url");

    // The classic privilege-escalation attempt: keep a valid signature, swap
    // the claims. The MAC covers the payload, so this must fail.
    await expect(
      verifySessionToken(`${header}.${forged}.${signature}`),
    ).resolves.toBeNull();
  });

  it("rejects a token whose role was rewritten by a previous algorithm choice", async () => {
    // "none" is the classic JWT downgrade. Pinning algorithms: ["HS256"] in
    // verifySessionToken is what makes this a rejection.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: PAYLOAD.userId, role: "ROOT", pc: "X", name: "X" }),
    ).toString("base64url");
    await expect(verifySessionToken(`${header}.${payload}.`)).resolves.toBeNull();
  });

  it("rejects a token issued for a different audience or issuer", async () => {
    // Both are checked by jose; a token minted by another service sharing the
    // secret must not be accepted here.
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(VALID_SECRET);
    const foreign = await new SignJWT({ role: "ROOT", pc: "X", name: "X" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(PAYLOAD.userId)
      .setIssuer("some-other-app")
      .setAudience("some-other-app:web")
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifySessionToken(foreign)).resolves.toBeNull();
  });

  it("rejects an expired token, proven with an injected clock", async () => {
    const t0 = 1_800_000_000;
    const token = await signSessionToken(PAYLOAD, { now: () => t0 });

    // One second before expiry: still valid.
    await expect(verifySessionToken(token, { now: () => t0 + SESSION_TTL_SECONDS - 1 }))
      .resolves.toEqual(PAYLOAD);
    // One second after: not.
    await expect(verifySessionToken(token, { now: () => t0 + SESSION_TTL_SECONDS + 1 }))
      .resolves.toBeNull();
  });

  it("defaults the lifetime to 8 hours, expiring strictly AT the boundary", async () => {
    const t0 = 1_800_000_000;
    const token = await signSessionToken(PAYLOAD, { now: () => t0 });

    // RFC 7519: the token is invalid once now >= exp, so the last valid instant
    // is one second BEFORE the boundary.
    await expect(verifySessionToken(token, { now: () => t0 + SESSION_TTL_SECONDS - 1 }))
      .resolves.toEqual(PAYLOAD);
    await expect(verifySessionToken(token, { now: () => t0 + SESSION_TTL_SECONDS }))
      .resolves.toBeNull();
    expect(SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
  });

  it("returns null rather than throwing for junk input", async () => {
    // A stale or hand-edited cookie must produce a login redirect, not a 500.
    for (const junk of ["", "not-a-jwt", "a.b.c", "....", "%20"]) {
      await expect(verifySessionToken(junk)).resolves.toBeNull();
    }
    await expect(verifySessionToken(undefined)).resolves.toBeNull();
    await expect(verifySessionToken(null)).resolves.toBeNull();
  });

  it("returns null when the secret is unusable, instead of throwing", async () => {
    // middleware catches nothing: null has to cover this path too, otherwise a
    // misconfigured stack turns every request into a 500 instead of a login.
    delete process.env.AUTH_SECRET;
    const token = "irrelevant";
    await expect(verifySessionToken(token)).resolves.toBeNull();
  });
});

describe("verifySessionToken — payload shape is validated, not trusted", () => {
  it("rejects a correctly signed token with a non-UUID userId", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(VALID_SECRET);
    const forged = await new SignJWT({ role: "ROOT", pc: "JJGYCMQ1", name: "X" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("not-a-uuid")
      .setIssuer("red-referidos")
      .setAudience("red-referidos:web")
      .setExpirationTime("1h")
      .sign(key);
    // Signature proves we minted it; it does not prove the shape survived a
    // schema change. Zod is what rejects this.
    await expect(verifySessionToken(forged)).resolves.toBeNull();
  });

  it("rejects a correctly signed token carrying an unknown role", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(VALID_SECRET);
    const forged = await new SignJWT({ role: "SUPERUSER", pc: "JJGYCMQ1", name: "X" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(PAYLOAD.userId)
      .setIssuer("red-referidos")
      .setAudience("red-referidos:web")
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifySessionToken(forged)).resolves.toBeNull();
  });
});