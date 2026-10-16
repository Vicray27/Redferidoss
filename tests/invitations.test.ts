// =============================================================================
// tests/invitations.test.ts — §8.2 links, R2/R3 quota arithmetic, §13.2 token
// handling. Unit-only: the fake client routes by the `/* @inv:… */` markers,
// the same convention the other suites use for injected loaders.
// =============================================================================

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AppError, toErrorResponse } from "../lib/errors";
import {
  ALLOW_MULTI_USE_LINK_SETTING,
  COUNT_PENDING_IN_LIMIT_SETTING,
  INVITE_INVALID_MESSAGE,
  INVITE_TTL_HOURS_SETTING,
  InviteInvalidError,
  NO_SLOTS_MESSAGE,
  ReferralLimitError,
  computeQuota,
  createInvitationsService,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  looksLikePublicCode,
  type InvitationsDb,
} from "../lib/invitations";
import type { SettingsLike } from "../lib/authz";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (values: unknown[]) => unknown;

class FakePg implements InvitationsDb {
  readonly calls: Array<{ marker: string; values: unknown[] }> = [];
  private readonly handlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.handlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.calls.filter((call) => call.marker === marker);
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* (@[\w:-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`FakePg: statement without marker: ${text}`);
    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`FakePg: no handler registered for ${marker}`);
    this.calls.push({ marker, values });
    return (await handler(values)) as T;
  }
}

function fakeSettings(entries: Record<string, unknown>): SettingsLike {
  return {
    getOrThrow: async <T = unknown>(key: string): Promise<T> => {
      if (!(key in entries)) throw new Error(`setting not seeded in fake: ${key}`);
      return entries[key] as T;
    },
  };
}

const HAPPY_SETTINGS = {
  [ALLOW_MULTI_USE_LINK_SETTING]: true,
  [COUNT_PENDING_IN_LIMIT_SETTING]: true,
  [INVITE_TTL_HOURS_SETTING]: 72,
};

const SPONSOR = {
  id: "11111111-1111-1111-1111-111111111111",
  publicCode: "JJGYCMQ1",
  fullName: "Ana Pérez",
  depth: 1,
  status: "ACTIVE",
};

const FIELDS_ROW = {
  code: "barrio",
  label: "Barrio",
  type: "TEXT",
  options: null,
  isRequired: false,
  regex: null,
  minNumeric: null,
  maxNumeric: null,
  sortOrder: 10,
  defaultValue: null,
};

function happyQuota(children: number, max: number, pending: number) {
  return { children: BigInt(children), max: BigInt(max), pending: BigInt(pending) };
}

function basePermanentService(overrides: Partial<Record<string, unknown>> = {}) {
  const db = new FakePg()
    .on("@inv:sponsor-by-code", () => [SPONSOR])
    .on("@inv:quota", () => [happyQuota(1, 3, 1)])
    .on("@inv:fields", () => [FIELDS_ROW]);
  const service = createInvitationsService(db, fakeSettings({ ...HAPPY_SETTINGS, ...overrides }));
  return { db, service };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("looksLikePublicCode — the two slugs are distinguishable by construction", () => {
  it.each([
    ["JJGYCMQ1", true],
    ["jjgycmq1", true],
    ["00000000", true],
    ["IIIIIIII", false], // I is excluded from the Crockford alphabet
    ["L0U0LLLL", false],
    ["JJGYCMQ", false], // 7 chars
    ["JJGYCMQ12", false], // 9 chars
    ["", false],
    [generateInviteToken(() => Buffer.alloc(32, 7)), false], // a real 43-char token
  ])("%s -> %s", (slug, expected) => {
    expect(looksLikePublicCode(slug)).toBe(expected);
  });
});

describe("token primitives", () => {
  it("hashes with plain SHA-256 hex — the only form ever stored (§13.2, §5.3)", () => {
    const token = "known-token";
    expect(hashInviteToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashInviteToken(token)).toHaveLength(64);
    expect(hashInviteToken(token)).not.toBe(hashInviteToken(`${token}!`));
  });

  it("generates 32 random bytes as 43 base64url chars", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(generateInviteToken());
  });

  it("is deterministic under an injected source (test seam)", () => {
    expect(generateInviteToken(() => Buffer.alloc(32, 0))).toBe("A".repeat(43));
  });
});

describe("inviteExpiry — TTL in hours, 0/absent means no expiry", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");

  it("adds the TTL hours", () => {
    expect(inviteExpiry(now, 72)?.toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });

  it("maps non-positive and non-finite TTLs to null", () => {
    expect(inviteExpiry(now, 0)).toBeNull();
    expect(inviteExpiry(now, -3)).toBeNull();
    expect(inviteExpiry(now, Number.NaN)).toBeNull();
  });
});

describe("computeQuota — R3 decides whether pending links reserve slots", () => {
  it("counts pending against the limit when R3 applies", () => {
    expect(computeQuota(2, 3, 10, true)).toEqual({
      children: 2,
      pending: 3,
      max: 10,
      used: 5,
      left: 5,
    });
  });

  it("ignores pending when R3 is off", () => {
    expect(computeQuota(2, 3, 10, false)).toEqual({
      children: 2,
      pending: 3,
      max: 10,
      used: 2,
      left: 8,
    });
  });

  it("clamps at zero when the quota was lowered below current usage (A1)", () => {
    expect(computeQuota(11, 0, 10, true).left).toBe(0);
  });

  it("never returns negative components", () => {
    expect(computeQuota(-1, -2, 5, true)).toEqual({
      children: 0,
      pending: 0,
      max: 5,
      used: 0,
      left: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveInvite
// ---------------------------------------------------------------------------

describe("resolveInvite — permanent link /r/{public_code}", () => {
  it("returns sponsor, quota and registration fields", async () => {
    const { db, service } = basePermanentService();
    const resolution = await service.resolveInvite("jjgycmq1");

    expect(resolution.kind).toBe("PERMANENT");
    expect(resolution.invitationId).toBeNull();
    expect(resolution.sponsor).toEqual({
      id: SPONSOR.id,
      publicCode: SPONSOR.publicCode,
      fullName: SPONSOR.fullName,
      depth: 1,
    });
    expect(resolution.slots).toEqual({
      children: 1,
      pending: 1,
      max: 3,
      used: 2,
      left: 1,
    });
    expect(resolution.fields).toEqual([FIELDS_ROW]);

    // The permanent link is excluded from nothing: every pending invitation
    // competes for the same free slots.
    expect(db.callsFor("@inv:quota")[0].values[1]).toBeNull();
  });

  it("refuses when referral.allow_multi_use_link is off (§6)", async () => {
    const { db, service } = basePermanentService({ [ALLOW_MULTI_USE_LINK_SETTING]: false });
    await expect(service.resolveInvite("JJGYCMQ1")).rejects.toMatchObject({
      name: "InviteInvalidError",
      reason: expect.stringContaining("disabled"),
    });
    // A disabled mode must not even touch the database.
    expect(db.callsFor("@inv:sponsor-by-code")).toHaveLength(0);
  });

  it("one generic 404 for unknown codes — no enumeration oracle (A2)", async () => {
    const db = new FakePg().on("@inv:sponsor-by-code", () => []);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));
    await expect(service.resolveInvite("JJGYCMQ1")).rejects.toMatchObject({
      name: "InviteInvalidError",
      reason: "unknown public_code",
      status: 404,
      code: "INVITE_INVALID",
    });
  });

  it("refuses a sponsor that is not ACTIVE (suspended or pending)", async () => {
    const db = new FakePg()
      .on("@inv:sponsor-by-code", () => [{ ...SPONSOR, status: "SUSPENDED" }])
      .on("@inv:quota", () => [happyQuota(0, 3, 0)])
      .on("@inv:fields", () => []);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));
    await expect(service.resolveInvite("JJGYCMQ1")).rejects.toMatchObject({
      name: "InviteInvalidError",
      reason: expect.stringContaining("SUSPENDED"),
    });
    // Quota must not be read for an unusable sponsor.
    expect(db.callsFor("@inv:quota")).toHaveLength(0);
  });

  it("ignores pending when count_pending_in_limit is false", async () => {
    const { service } = basePermanentService({ [COUNT_PENDING_IN_LIMIT_SETTING]: false });
    const resolution = await service.resolveInvite("JJGYCMQ1");
    expect(resolution.slots.used).toBe(1); // children only
    expect(resolution.slots.left).toBe(2);
  });
});

describe("resolveInvite — single-use token", () => {
  const TOKEN = "tok_single_use";
  const INVITATION = {
    id: "22222222-2222-2222-2222-222222222222",
    inviterId: SPONSOR.id,
    kind: "SINGLE",
    emailTarget: "invitado@example.com",
    maxUses: 1,
    uses: 0,
    expiresAt: null,
    revokedAt: null,
  };

  function tokenService(invitation: unknown, quota = happyQuota(0, 3, 0)) {
    const db = new FakePg()
      .on("@inv:invitation-by-hash", () => (invitation ? [invitation] : []))
      .on("@inv:sponsor-by-id", () => [{ ...SPONSOR }])
      .on("@inv:quota", () => [quota])
      .on("@inv:fields", () => []);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));
    return { db, service };
  }

  it("resolves the invitation, its sponsor and its directed email", async () => {
    const { db, service } = tokenService(INVITATION);
    const resolution = await service.resolveInvite(TOKEN);

    expect(resolution.kind).toBe("SINGLE");
    expect(resolution.invitationId).toBe(INVITATION.id);
    expect(resolution.emailTarget).toBe("invitado@example.com");

    // The invitation being resolved is EXCLUDED from the pending count: it is
    // about to fill its reserved slot, and counting it against itself would
    // block the very person it was issued to.
    expect(db.callsFor("@inv:quota")[0].values[1]).toBe(INVITATION.id);
    // And the lookup goes by hash, never by the plain token (§13.2).
    expect(db.callsFor("@inv:invitation-by-hash")[0].values[0]).toBe(hashInviteToken(TOKEN));
  });

  it.each([
    ["revoked", { ...INVITATION, revokedAt: new Date("2026-01-01T00:00:00Z") }, "token revoked"],
    ["expired", { ...INVITATION, expiresAt: new Date("2020-01-01T00:00:00Z") }, "token expired"],
    ["exhausted", { ...INVITATION, uses: 1, maxUses: 1 }, "token exhausted"],
    ["unknown", null, "unknown token"],
  ])("rejects a %s token with the same generic 404", async (_label, invitation, reason) => {
    const { service } = tokenService(invitation);
    await expect(service.resolveInvite(TOKEN)).rejects.toMatchObject({
      name: "InviteInvalidError",
      reason,
      status: 404,
      code: "INVITE_INVALID",
    });
  });

  it("speaks the same sentence for every dead link — `reason` never leaks (A2)", async () => {
    const cases = [
      await tokenService({ ...INVITATION, revokedAt: new Date("2026-01-01T00:00:00Z") })
        .service.resolveInvite(TOKEN)
        .catch((error: unknown) => error),
      await tokenService(null)
        .service.resolveInvite(TOKEN)
        .catch((error: unknown) => error),
      await tokenService(INVITATION)
        .service.resolveInvite("   ")
        .catch((error: unknown) => error),
    ];

    for (const error of cases) {
      expect(error).toBeInstanceOf(InviteInvalidError);
      // message is a non-enumerable Error property; compare it directly.
      expect((error as Error).message).toBe(INVITE_INVALID_MESSAGE);
    }
  });

  it("rejects an empty slug before touching the database", async () => {
    const { db, service } = tokenService(INVITATION);
    await expect(service.resolveInvite("   ")).rejects.toMatchObject({
      reason: "empty slug",
    });
    expect(db.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createSingleUse / revoke / consume / listPending
// ---------------------------------------------------------------------------

describe("createSingleUse — §8.2 'validar cupo disponible' before issuing", () => {
  it("stores only the hash, one use, and the TTL-derived expiry", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const db = new FakePg()
      .on("@inv:quota", () => [happyQuota(0, 3, 0)])
      .on("@inv:insert", () => [{ id: "inv-new" }]);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS), {
      now: () => now,
    });

    const created = await service.createSingleUse(SPONSOR.id);

    expect(created.id).toBe("inv-new");
    const [, hash, emailTarget, expiresAt] = db.callsFor("@inv:insert")[0].values;
    expect(hash).toBe(hashInviteToken(created.token)); // plain token never stored
    expect(emailTarget).toBeNull();
    expect((expiresAt as Date).toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });

  it("normalizes a directed email_target to lower case", async () => {
    const db = new FakePg()
      .on("@inv:quota", () => [happyQuota(0, 3, 0)])
      .on("@inv:insert", () => [{ id: "inv-new" }]);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));
    await service.createSingleUse(SPONSOR.id, { emailTarget: "  InVitado@Example.COM " });
    expect(db.callsFor("@inv:insert")[0].values[2]).toBe("invitado@example.com");
  });

  it("refuses to issue when no slot is free (R2/R3)", async () => {
    const db = new FakePg().on("@inv:quota", () => [happyQuota(3, 3, 0)]);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));

    await expect(service.createSingleUse(SPONSOR.id)).rejects.toMatchObject({
      name: "ReferralLimitError",
      status: 409,
      code: "REFERRAL_LIMIT_REACHED",
      message: NO_SLOTS_MESSAGE,
    });
    expect(db.callsFor("@inv:insert")).toHaveLength(0);
  });

  it("honors expiresInHours = 0 by issuing a non-expiring link", async () => {
    const db = new FakePg()
      .on("@inv:quota", () => [happyQuota(0, 3, 0)])
      .on("@inv:insert", () => [{ id: "inv-new" }]);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));
    await service.createSingleUse(SPONSOR.id, { expiresInHours: 0 });
    expect(db.callsFor("@inv:insert")[0].values[3]).toBeNull();
  });
});

describe("revoke / consume / listPending", () => {
  it("revoke reports true only when one of the caller's live rows matched", async () => {
    const db = new FakePg()
      .on("@inv:revoke", (values) => (values[0] === "mine" ? [{ id: "mine" }] : []));
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));

    expect(await service.revoke("user-1", "mine")).toBe(true);
    expect(await service.revoke("user-1", "not-mine")).toBe(false);
    // Ownership is enforced in the WHERE clause, not by a prior SELECT:
    // [invitationId, userId] in statement order.
    expect(db.callsFor("@inv:revoke")[0].values).toEqual(["mine", "user-1"]);
  });

  it("consume reports false when the row is no longer consumable", async () => {
    const db = new FakePg().on("@inv:consume", (values) => (values[0] === "live" ? [{ id: "live" }] : []));
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));

    expect(await service.consume("live")).toBe(true);
    expect(await service.consume("dead")).toBe(false);
  });

  it("listPending passes the user and returns rows untouched", async () => {
    const rows = [
      {
        id: "inv-1",
        kind: "SINGLE",
        emailTarget: null,
        maxUses: 1,
        uses: 0,
        expiresAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ];
    const db = new FakePg().on("@inv:list-pending", () => rows);
    const service = createInvitationsService(db, fakeSettings(HAPPY_SETTINGS));

    expect(await service.listPending("user-1")).toEqual(rows);
    expect(db.callsFor("@inv:list-pending")[0].values[0]).toBe("user-1");
  });
});

// ---------------------------------------------------------------------------
// Envelope contract (§10)
// ---------------------------------------------------------------------------

describe("errors ride the §10 envelope like every other AppError", () => {
  it("InviteInvalidError serializes to 404 INVITE_INVALID with the generic text", async () => {
    const error = new InviteInvalidError("token expired");
    expect(error).toBeInstanceOf(AppError);

    const response = toErrorResponse(error);
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(body).toEqual({
      ok: false,
      error: { code: "INVITE_INVALID", message: INVITE_INVALID_MESSAGE },
    });
  });

  it("ReferralLimitError serializes to 409 REFERRAL_LIMIT_REACHED", async () => {
    const response = toErrorResponse(new ReferralLimitError());
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REFERRAL_LIMIT_REACHED");
  });
});
