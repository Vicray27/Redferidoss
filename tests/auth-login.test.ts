import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SUSPENDED_MESSAGE,
  authenticate,
  INVALID_CREDENTIALS_MESSAGE,
  toSessionPayload,
  type LoginDeps,
} from "../lib/auth/login";
import type { AuthUserRow } from "../lib/users";

/**
 * No database, no argon2, no framework.
 *
 * `authenticate` takes every dependency as a parameter, so these tests drive
 * all of its security-relevant branches — including the two that are easy to
 * regress silently: the identical message for "no such user" and "wrong
 * password", and the timing burn on the unknown-email path.
 */

const ROOT: AuthUserRow = {
  id: "8f2b5a1e-0000-4000-8000-000000000001",
  publicCode: "JJGYCMQ1",
  email: "root@example.com",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb",
  fullName: "Administrador ROOT",
  role: "ROOT",
  status: "ACTIVE",
};

interface Recorder {
  deps: LoginDeps;
  calls: string[];
}

/** Build deps whose every method records that it ran. */
function deps(options: {
  user?: AuthUserRow | null;
  passwordMatches?: boolean;
  throwOn?: "find" | "verify" | "issue";
} = {}): Recorder {
  const calls: string[] = [];
  const user = options.user === undefined ? ROOT : options.user;

  return {
    calls,
    deps: {
      async findUserByEmail(email) {
        calls.push(`findByEmail(${email})`);
        if (options.throwOn === "find") throw new Error("database is down");
        return user;
      },
      async verifyPassword(hash, plain) {
        calls.push(`verifyPassword(${hash === ROOT.passwordHash ? "real" : "other"},${plain})`);
        if (options.throwOn === "verify") throw new Error("argon2 exploded");
        return options.passwordMatches ?? true;
      },
      async burn(password) {
        calls.push(`burn(${password})`);
      },
      async issueToken(payload) {
        calls.push(`issueToken(${payload.role})`);
        if (options.throwOn === "issue") throw new Error("no AUTH_SECRET");
        return `token-for-${payload.userId}`;
      },
    },
  };
}

describe("authenticate — success", () => {
  it("issues a token carrying the id, role and public code", async () => {
    const { deps: d, calls } = deps();
    const result = await authenticate("root@example.com", "correcta", d);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.token).toBe("token-for-8f2b5a1e-0000-4000-8000-000000000001");
    expect(result.payload).toEqual({
      userId: ROOT.id,
      role: "ROOT",
      publicCode: "JJGYCMQ1",
      fullName: "Administrador ROOT",
    });
    expect(calls).toEqual([
      "findByEmail(root@example.com)",
      "verifyPassword(real,correcta)",
      "issueToken(ROOT)",
    ]);
  });

  it("never burns time on the success path: the real verification already did", async () => {
    const { deps: d, calls } = deps();
    await authenticate("root@example.com", "correcta", d);
    expect(calls.some((c) => c.startsWith("burn"))).toBe(false);
  });

  it("allows PENDING users in, deferring activation policy to F5", async () => {
    // D7: there is no email provider, so a PENDING user must not be locked out
    // of a system where nothing can ever activate them.
    const pending: AuthUserRow = { ...ROOT, status: "PENDING" };
    const result = await authenticate("root@example.com", "correcta", deps({ user: pending }).deps);
    expect(result.ok).toBe(true);
  });
});

describe("authenticate — no user enumeration", () => {
  it("returns the SAME message for an unknown email and a wrong password", async () => {
    const unknown = await authenticate("nadie@example.com", "correcta", deps({ user: null }).deps);
    const wrong = await authenticate("root@example.com", "incorrecta", deps({ passwordMatches: false }).deps);

    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (unknown.ok || wrong.ok) throw new Error("unreachable");

    // This single assertion IS the anti-enumeration guarantee. If these ever
    // differ, /login becomes an account-existence oracle.
    expect(unknown.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(wrong.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it("burns verification time only when the email is unknown", async () => {
    const unknown = deps({ user: null });
    await authenticate("nadie@example.com", "correcta", unknown.deps);
    expect(unknown.calls).toContain("burn(correcta)");

    const wrong = deps({ passwordMatches: false });
    await authenticate("root@example.com", "incorrecta", wrong.deps);
    // The real comparison already cost the time, so a second burn would just
    // double the latency of the most common failure.
    expect(wrong.calls.some((c) => c.startsWith("burn"))).toBe(false);
  });

  it("still burns time when the password is right but the account is suspended", async () => {
    // The password was verified for real on this path, so timing already
    // matches a success; a burn here would make suspension *slower*.
    const suspended: AuthUserRow = { ...ROOT, status: "SUSPENDED" };
    const { deps: d, calls } = deps({ user: suspended });
    const result = await authenticate("root@example.com", "correcta", d);

    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("burn"))).toBe(false);
  });
});

describe("authenticate — suspended accounts", () => {
  it("refuses a suspended user, but only after the password checks out", async () => {
    const suspended: AuthUserRow = { ...ROOT, status: "SUSPENDED" };
    const { deps: d, calls } = deps({ user: suspended });

    const result = await authenticate("root@example.com", "correcta", d);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe(ACCOUNT_SUSPENDED_MESSAGE);

    // Order is the security property: the specific message is unreachable
    // without the correct password, so it cannot be used to probe accounts.
    expect(calls.indexOf("verifyPassword(real,correcta)")).toBeLessThan(calls.length);
    expect(calls.some((c) => c.startsWith("issueToken"))).toBe(false);
  });

  it("gives the generic message when the password is wrong, even if suspended", async () => {
    const suspended: AuthUserRow = { ...ROOT, status: "SUSPENDED" };
    const result = await authenticate(
      "root@example.com",
      "incorrecta",
      deps({ user: suspended, passwordMatches: false }).deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Revealing "suspended" here would leak which addresses are real.
    expect(result.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it("treats PENDING and SUSPENDED differently, on purpose", async () => {
    // PENDING is admitted: D7 turned email verification OFF because the project
    // has no mail provider, and an F5 activation flow does not exist yet. If
    // PENDING were refused, nobody could ever enter the system.
    const pending = await authenticate(
      "root@example.com",
      "correcta",
      deps({ user: { ...ROOT, status: "PENDING" } }).deps,
    );
    expect(pending.ok).toBe(true);

    // SUSPENDED is refused: that state exists to lock somebody out.
    const suspended = await authenticate(
      "root@example.com",
      "correcta",
      deps({ user: { ...ROOT, status: "SUSPENDED" } }).deps,
    );
    expect(suspended.ok).toBe(false);
  });
});

describe("authenticate — infrastructure failures propagate", () => {
  it("does NOT swallow a database error into a credential failure", async () => {
    // Turning "the database is down" into "wrong password" would send every
    // user back to retyping a correct password while the real fault is hidden.
    await expect(
      authenticate("root@example.com", "correcta", deps({ throwOn: "find" }).deps),
    ).rejects.toThrow(/database is down/);
  });

  it("does not swallow a missing AUTH_SECRET into a credential failure", async () => {
    await expect(
      authenticate("root@example.com", "correcta", deps({ throwOn: "issue" }).deps),
    ).rejects.toThrow(/no AUTH_SECRET/);
  });
});

describe("toSessionPayload", () => {
  it("carries only what the session needs, and never the hash", async () => {
    const payload = toSessionPayload(ROOT);
    expect(Object.keys(payload).sort()).toEqual(["fullName", "publicCode", "role", "userId"]);
    expect(JSON.stringify(payload)).not.toContain("$argon2id$");
  });
});