// =============================================================================
// tests/registration.test.ts — §8.3 self-registration: quota race (A3),
// R3 pending reservations, R4 depth, custom fields, obligations and audit.
//
// The fake client implements a REAL per-sponsor mutex for `@reg:lock-sponsor`:
// a `SELECT … FOR UPDATE` that actually serializes is the whole point of the
// flow, and a fake that never blocks would make the race test a tautology.
// The invitations service under test is the REAL one, running over the same
// fake state through `invitationsFor(tx)` — so quota reads are live.
// =============================================================================

import { describe, expect, it } from "vitest";

import { ValidationError } from "../lib/errors";
import {
  ALLOW_MULTI_USE_LINK_SETTING,
  COUNT_PENDING_IN_LIMIT_SETTING,
  INVITE_TTL_HOURS_SETTING,
  MAX_DEPTH_SETTING,
  createInvitationsService,
  hashInviteToken,
} from "../lib/invitations";
import {
  AUTO_APPROVE_SETTING,
  DepthLimitError,
  PENDING_AMOUNT_SETTING,
  REGISTRATION_CONFLICT_MESSAGE,
  REQUIRE_EMAIL_VERIFICATION_SETTING,
  RegistrationConflictError,
  emptyToNull,
  isUniqueViolation,
  randomPublicCode,
  registerUser,
  type RegistrationDeps,
  type RegistrationTx,
} from "../lib/registration";
import type { SettingsLike } from "../lib/authz";

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

interface FakeUser {
  id: string;
  email: string;
  publicCode: string;
  sponsorId: string | null;
  depth: number;
  status: string;
  fullName: string;
  passwordHash: string;
}

interface FakeInvitation {
  id: string;
  inviterId: string;
  tokenHash: string;
  kind: string;
  emailTarget: string | null;
  maxUses: number;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface FakeCustomField {
  id: string;
  code: string;
  label: string;
  type: string;
  options: unknown;
  isRequired: boolean;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
}

class RegistrationFake {
  readonly users: FakeUser[] = [];
  readonly invitations: FakeInvitation[] = [];
  readonly cycles: Array<{ id: string }> = [];
  readonly obligations: Array<{ cycleId: string; userId: string; expectedAmount: string }> = [];
  readonly audits: Array<{
    actorId: string;
    entityId: string;
    after: Record<string, unknown>;
    ip: string | null;
    userAgent: string | null;
  }> = [];
  readonly fieldValues: Array<{ fieldId: string; entityId: string; value: unknown }> = [];
  readonly calls: Array<{ marker: string; values: unknown[] }> = [];

  customFields: FakeCustomField[] = [];
  maxReferrals = 12;
  codes: string[] = [];
  private codeCursor = 0;
  insertUserError: unknown = null;
  private readonly mutexes = new Map<string, Promise<void>>();

  nextCode(): string {
    const fromSequence = this.codes[this.codeCursor];
    this.codeCursor += 1;
    return fromSequence ?? `GEN${String(this.codeCursor).padStart(5, "0")}`;
  }

  async $transaction<T>(fn: (tx: RegistrationTx) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    const tx: RegistrationTx = {
      $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
        this.query(strings, values, releases) as Promise<T>,
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  }

  /** A real serializing lock, keyed by sponsor id. */
  private async acquire(key: string): Promise<() => void> {
    const previous = this.mutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(key, previous.then(() => next));
    await previous;
    return release;
  }

  private async query(
    strings: TemplateStringsArray,
    values: unknown[],
    releases: Array<() => void>,
  ): Promise<unknown> {
    const text = strings.join("?");
    const marker = /\/\* (@[\w:-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`FakePg: statement without marker: ${text}`);
    this.calls.push({ marker, values });

    const sponsorShape = (user: FakeUser) => ({
      id: user.id,
      publicCode: user.publicCode,
      fullName: user.fullName,
      depth: user.depth,
      status: user.status,
    });

    switch (marker) {
      case "@inv:sponsor-by-code": {
        const user = this.users.find((u) => u.publicCode === values[0]);
        return user ? [sponsorShape(user)] : [];
      }
      case "@inv:sponsor-by-id": {
        const user = this.users.find((u) => u.id === values[0]);
        return user ? [sponsorShape(user)] : [];
      }
      case "@inv:invitation-by-hash": {
        const row = this.invitations.find((i) => i.tokenHash === values[0]);
        return row ? [row] : [];
      }
      case "@inv:quota": {
        const [userId, exclude] = values as [string, string | null];
        const sponsor = this.users.find((u) => u.id === userId);
        if (!sponsor) return [];
        const now = Date.now();
        const children = this.users.filter((u) => u.sponsorId === userId).length;
        const pending = this.invitations.filter(
          (i) =>
            i.inviterId === userId &&
            !i.revokedAt &&
            (!i.expiresAt || i.expiresAt.getTime() > now) &&
            i.uses < i.maxUses &&
            i.id !== exclude,
        ).length;
        return [{ children: BigInt(children), max: BigInt(this.maxReferrals), pending: BigInt(pending) }];
      }
      case "@inv:fields":
      case "@reg:fields": {
        return this.customFields.map((field) => ({ ...field }));
      }
      case "@inv:consume": {
        const row = this.invitations.find((i) => i.id === values[0]);
        if (!row || row.revokedAt || row.uses >= row.maxUses) return [];
        if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return [];
        row.uses += 1;
        return [{ id: row.id }];
      }
      case "@reg:lock-sponsor": {
        const release = await this.acquire(String(values[0]));
        releases.push(release);
        const user = this.users.find((u) => u.id === values[0]);
        return user ? [{ id: user.id, depth: user.depth, status: user.status }] : [];
      }
      case "@reg:email-exists": {
        const email = String(values[0]).toLowerCase();
        return this.users.some((u) => u.email.toLowerCase() === email) ? [{ one: 1 }] : [];
      }
      case "@reg:code-exists": {
        return this.users.some((u) => u.publicCode === values[0]) ? [{ one: 1 }] : [];
      }
      case "@reg:insert-user": {
        if (this.insertUserError) throw this.insertUserError;
        const [
          publicCode,
          sponsorId,
          email,
          passwordHash,
          fullName,
          nationalId,
          phone,
          birthDate,
          country,
          state,
          city,
          address,
          status,
        ] = values as string[];
        const sponsor = this.users.find((u) => u.id === sponsorId);
        if (!sponsor) throw new Error("fake: sponsor missing on insert");
        const id = `user-${this.users.length + 1}`;
        this.users.push({
          id,
          email,
          publicCode,
          sponsorId,
          depth: sponsor.depth + 1, // the trigger's job in production
          status,
          fullName,
          passwordHash,
        });
        void [nationalId, phone, birthDate, country, state, city, address];
        return [{ id, publicCode, status }];
      }
      case "@reg:insert-field-value": {
        const [fieldId, entityId, json] = values as [string, string, string];
        this.fieldValues.push({ fieldId, entityId, value: JSON.parse(json) });
        return [];
      }
      case "@reg:open-cycle": {
        return this.cycles.length > 0 ? [this.cycles[0]] : [];
      }
      case "@reg:insert-obligation": {
        const [cycleId, userId, expectedAmount] = values as [string, string, string];
        this.obligations.push({ cycleId, userId, expectedAmount });
        return [];
      }
      case "@reg:audit": {
        const [actorId, entityId, json, ip, userAgent] = values as [
          string,
          string,
          string,
          string | null,
          string | null,
        ];
        this.audits.push({
          actorId,
          entityId,
          after: JSON.parse(json) as Record<string, unknown>,
          ip,
          userAgent,
        });
        return [];
      }
      default:
        throw new Error(`FakePg: no handler for ${marker}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SETTINGS: Record<string, unknown> = {
  [ALLOW_MULTI_USE_LINK_SETTING]: true,
  [COUNT_PENDING_IN_LIMIT_SETTING]: true,
  [INVITE_TTL_HOURS_SETTING]: 72,
  [MAX_DEPTH_SETTING]: 0,
  [AUTO_APPROVE_SETTING]: true,
  [REQUIRE_EMAIL_VERIFICATION_SETTING]: false,
  [PENDING_AMOUNT_SETTING]: "10.00",
};

function fakeSettings(entries: Record<string, unknown>): SettingsLike {
  return {
    getOrThrow: async <T = unknown>(key: string): Promise<T> => {
      if (!(key in entries)) throw new Error(`setting not seeded in fake: ${key}`);
      return entries[key] as T;
    },
  };
}

function seedSponsor(fake: RegistrationFake, overrides: Partial<FakeUser> = {}): FakeUser {
  const sponsor: FakeUser = {
    id: "sponsor-1",
    email: "ana@example.com",
    publicCode: "JJGYCMQ1",
    sponsorId: null,
    depth: 0,
    status: "ACTIVE",
    fullName: "Ana Pérez",
    passwordHash: "root-hash",
    ...overrides,
  };
  fake.users.push(sponsor);
  return sponsor;
}

function seedInvitation(fake: RegistrationFake, overrides: Partial<FakeInvitation> = {}): FakeInvitation {
  const invitation: FakeInvitation = {
    id: "inv-1",
    inviterId: "sponsor-1",
    tokenHash: hashInviteToken("tok-1"),
    kind: "SINGLE",
    emailTarget: null,
    maxUses: 1,
    uses: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
  fake.invitations.push(invitation);
  return invitation;
}

function makeDeps(
  fake: RegistrationFake,
  settingsEntries: Record<string, unknown> = {},
  options: { hashSpy?: (plain: string) => void } = {},
): RegistrationDeps {
  const settings = fakeSettings({ ...BASE_SETTINGS, ...settingsEntries });
  return {
    db: fake,
    settings,
    invitationsFor: (tx: RegistrationTx) => createInvitationsService(tx, settings),
    hashPassword: async (plain: string) => {
      options.hashSpy?.(plain);
      return `hashed(${plain})`;
    },
    generatePublicCode: () => fake.nextCode(),
  };
}

const INPUT = {
  invite: "JJGYCMQ1",
  email: "Nuevo@Example.com",
  password: "secreto123",
  fullName: "Nuevo Miembro",
};

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

describe("registerUser — permanent link happy path", () => {
  it("creates the user under the sponsor with a hashed password and a clean audit", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);

    const result = await registerUser(INPUT, { ip: "10.0.0.1", userAgent: "vitest" }, makeDeps(fake));

    expect(result).toMatchObject({
      userId: "user-2",
      email: "nuevo@example.com",
      fullName: "Nuevo Miembro",
      status: "ACTIVE",
      sponsorId: "sponsor-1",
      sponsorName: "Ana Pérez",
      invitationKind: "PERMANENT",
      obligationCreated: false,
    });

    const created = fake.users[1];
    expect(created.sponsorId).toBe("sponsor-1");
    expect(created.depth).toBe(1);
    expect(created.status).toBe("ACTIVE");
    // The stored value is exactly what the injected hasher returned — the
    // real Argon2 wiring is covered by the password module's own tests.
    expect(created.passwordHash).toBe("hashed(secreto123)");

    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      actorId: "user-2",
      entityId: "user-2",
      ip: "10.0.0.1",
      userAgent: "vitest",
    });
    expect(fake.audits[0].after).toMatchObject({
      sponsorId: "sponsor-1",
      invitationKind: "PERMANENT",
      status: "ACTIVE",
    });
    // §13: the audit trail never stores email, password or name.
    const auditText = JSON.stringify(fake.audits[0]);
    expect(auditText).not.toContain("nuevo@example.com");
    expect(auditText).not.toContain("secreto123");
    expect(auditText).not.toContain("Nuevo Miembro");
  });
});

describe("registerUser — A3: the quota race", () => {
  it("lets exactly one of two concurrent registrations take the last slot", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.maxReferrals = 1;

    const results = await Promise.allSettled([
      registerUser({ ...INPUT, email: "first@example.com" }, {}, makeDeps(fake)),
      registerUser({ ...INPUT, email: "second@example.com" }, {}, makeDeps(fake)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "AppError",
      status: 409,
      code: "REFERRAL_LIMIT_REACHED",
    });

    // Only one child exists, one audit entry, and the loser wrote nothing.
    expect(fake.users.filter((u) => u.sponsorId === "sponsor-1")).toHaveLength(1);
    expect(fake.audits).toHaveLength(1);
  });

  it("re-validates AFTER the lock: a revoked token found on the second resolve wins", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    const invitation = seedInvitation(fake);

    // First resolve (before the lock) sees a live invitation; by the time the
    // sponsor lock is held, it has been revoked. Acting on the first snapshot
    // would register a user through a dead link — that is the A3 bug.
    let resolutions = 0;
    const originalQuery = fake["query"].bind(fake);
    (fake as unknown as { query: typeof originalQuery }).query = async (strings, values, releases) => {
      const text = strings.join("?");
      if (text.includes("@inv:invitation-by-hash")) {
        resolutions += 1;
        if (resolutions === 1) return [invitation];
        return [{ ...invitation, revokedAt: new Date() }];
      }
      return originalQuery(strings, values, releases);
    };

    await expect(
      registerUser({ ...INPUT, invite: "tok-1" }, {}, makeDeps(fake)),
    ).rejects.toMatchObject({ name: "InviteInvalidError", reason: "token revoked" });

    expect(fake.users.filter((u) => u.sponsorId === "sponsor-1")).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });
});

describe("registerUser — R3 pending links reserve slots", () => {
  it("counts an unconsumed invitation against the limit on the next registration", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.maxReferrals = 2;
    seedInvitation(fake); // one pending single-use link

    // children 0 + pending 1 = 1 used, one free slot left.
    await expect(registerUser({ ...INPUT, email: "one@example.com" }, {}, makeDeps(fake))).resolves.toMatchObject({
      status: "ACTIVE",
    });

    // children 1 + pending 1 = 2 used: the third entrant is refused.
    await expect(registerUser({ ...INPUT, email: "two@example.com" }, {}, makeDeps(fake))).rejects.toMatchObject({
      code: "REFERRAL_LIMIT_REACHED",
    });
    expect(fake.users.filter((u) => u.sponsorId === "sponsor-1")).toHaveLength(1);
  });

  it("lets a single-use invitation fill the slot it reserved for itself", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.maxReferrals = 1;
    seedInvitation(fake); // the ONLY pending link, max quota of 1

    const result = await registerUser({ ...INPUT, invite: "tok-1" }, {}, makeDeps(fake));

    expect(result.invitationKind).toBe("SINGLE");
    expect(fake.invitations[0].uses).toBe(1);
    expect(fake.users.filter((u) => u.sponsorId === "sponsor-1")).toHaveLength(1);
  });
});

describe("registerUser — directed invitations and depth", () => {
  it("refuses a directed invitation submitted with a different email", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    seedInvitation(fake, { emailTarget: "invitado@example.com" });

    await expect(
      registerUser({ ...INPUT, invite: "tok-1", email: "otro@example.com" }, {}, makeDeps(fake)),
    ).rejects.toMatchObject({
      name: "RegistrationConflictError",
      code: "REGISTRATION_CONFLICT",
    });
    expect(fake.invitations[0].uses).toBe(0);
    expect(fake.users).toHaveLength(1); // sponsor only
  });

  it("accepts a directed invitation when the email matches (case-insensitive)", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    seedInvitation(fake, { emailTarget: "invitado@example.com" });

    await expect(
      registerUser({ ...INPUT, invite: "tok-1", email: "Invitado@Example.COM" }, {}, makeDeps(fake)),
    ).resolves.toMatchObject({ invitationKind: "SINGLE" });
  });

  it("R4: refuses to grow past referral.max_depth, and 0 means unlimited", async () => {
    const limited = new RegistrationFake();
    seedSponsor(limited, { depth: 2 });
    await expect(
      registerUser(INPUT, {}, makeDeps(limited, { [MAX_DEPTH_SETTING]: 2 })),
    ).rejects.toMatchObject({
      name: "DepthLimitError",
      status: 409,
      code: "DEPTH_LIMIT_REACHED",
    });
    expect(limited.users).toHaveLength(1);
    expect(limited.audits).toHaveLength(0);

    const unlimited = new RegistrationFake();
    seedSponsor(unlimited, { depth: 40 });
    await expect(
      registerUser(INPUT, {}, makeDeps(unlimited, { [MAX_DEPTH_SETTING]: 0 })),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });
});

describe("registerUser — identity and status rules", () => {
  it("one generic 409 for a duplicate email — no enumeration oracle", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);

    await expect(
      registerUser({ ...INPUT, email: "ANA@example.COM" }, {}, makeDeps(fake)),
    ).rejects.toMatchObject({
      name: "RegistrationConflictError",
      status: 409,
      code: "REGISTRATION_CONFLICT",
    });
    try {
      await registerUser({ ...INPUT, email: "ana@example.com" }, {}, makeDeps(fake));
    } catch (error) {
      expect((error as Error).message).toBe(REGISTRATION_CONFLICT_MESSAGE);
    }
    expect(fake.users).toHaveLength(1);
  });

  it("maps a Postgres unique violation on insert to the same generic 409", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    // Simulate the race the pre-check cannot close: another transaction wins
    // the unique index between our SELECT and our INSERT.
    fake.insertUserError = Object.assign(new Error("duplicate key"), {
      meta: { code: "23505" },
    });

    await expect(registerUser(INPUT, {}, makeDeps(fake))).rejects.toMatchObject({
      name: "RegistrationConflictError",
      code: "REGISTRATION_CONFLICT",
    });
  });

  it("parks the user in PENDING when auto-approval is off", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    const result = await registerUser(
      INPUT,
      {},
      makeDeps(fake, { [AUTO_APPROVE_SETTING]: false }),
    );
    expect(result.status).toBe("PENDING");
    expect(fake.users[1].status).toBe("PENDING");
  });

  it("parks the user in PENDING when email verification is required (no mail provider, D7)", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    const result = await registerUser(
      INPUT,
      {},
      makeDeps(fake, { [REQUIRE_EMAIL_VERIFICATION_SETTING]: true }),
    );
    expect(result.status).toBe("PENDING");
  });

  it("retries the public code when the first pick collides", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.users.push({ ...fake.users[0], id: "other", publicCode: "AAAAAAAA", sponsorId: "sponsor-1", depth: 1 });
    fake.codes = ["AAAAAAAA", "BBBBBBBB"];

    const result = await registerUser(INPUT, {}, makeDeps(fake));

    expect(result.publicCode).toBe("BBBBBBBB");
    expect(fake.calls.filter((c) => c.marker === "@reg:code-exists")).toHaveLength(2);
  });

  it("rejects malformed input before hashing or opening a transaction", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    let hashCalls = 0;

    await expect(
      registerUser(
        { ...INPUT, email: "not-an-email", password: "short" },
        {},
        makeDeps(fake, {}, { hashSpy: () => { hashCalls += 1; } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(hashCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("registerUser — custom fields and obligations", () => {
  const FIELDS: FakeCustomField[] = [
    {
      id: "field-text",
      code: "barrio",
      label: "Barrio",
      type: "TEXT",
      options: null,
      isRequired: true,
      regex: null,
      minNumeric: null,
      maxNumeric: null,
    },
    {
      id: "field-amount",
      code: "meta",
      label: "Meta",
      type: "DECIMAL",
      options: null,
      isRequired: false,
      regex: null,
      minNumeric: "0",
      maxNumeric: "1000",
    },
  ];

  it("stores validated custom values; DECIMAL keeps its exact text form", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.customFields = FIELDS;

    await registerUser(
      { ...INPUT, custom: { barrio: "Centro", meta: "10.50" } },
      {},
      makeDeps(fake),
    );

    expect(fake.fieldValues).toEqual([
      { fieldId: "field-text", entityId: "user-2", value: "Centro" },
      { fieldId: "field-amount", entityId: "user-2", value: "10.50" },
    ]);
    // Not the number 10.5: NUMERIC never round-trips through float.
    expect(typeof fake.fieldValues[1].value).toBe("string");
  });

  it("rejects a missing required custom field with Zod-style details", async () => {
    const fake = new RegistrationFake();
    seedSponsor(fake);
    fake.customFields = FIELDS;

    await expect(
      registerUser({ ...INPUT, custom: {} }, {}, makeDeps(fake)),
    ).rejects.toMatchObject({
      name: "ValidationError",
      status: 400,
      details: { barrio: ["Este campo es obligatorio."] },
    });
    expect(fake.fieldValues).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });

  it("creates the cycle obligation only when a cycle is already OPEN", async () => {
    const withCycle = new RegistrationFake();
    seedSponsor(withCycle);
    withCycle.cycles.push({ id: "cycle-1" });

    const result = await registerUser(INPUT, {}, makeDeps(withCycle));
    expect(result.obligationCreated).toBe(true);
    expect(withCycle.obligations).toEqual([
      { cycleId: "cycle-1", userId: "user-2", expectedAmount: "10.00" },
    ]);

    const withoutCycle = new RegistrationFake();
    seedSponsor(withoutCycle);
    const solo = await registerUser(INPUT, {}, makeDeps(withoutCycle));
    expect(solo.obligationCreated).toBe(false);
    expect(withoutCycle.obligations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("randomPublicCode", () => {
  it("draws 8 chars from the Crockford alphabet and is injectable", () => {
    const code = randomPublicCode(() => Buffer.alloc(8, 3));
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(code).toBe("33333333");
    expect(randomPublicCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});

// The validateCustomValue / collectCustomValues suites moved to
// tests/custom-fields.test.ts together with the rules themselves (D56).

describe("emptyToNull", () => {
  it("maps blank strings to NULL and keeps real ones", () => {
    expect(emptyToNull("  ")).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(" Asunción ")).toBe("Asunción");
  });
});

describe("isUniqueViolation", () => {
  it("recognizes the 23505 shapes and nothing else", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ meta: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "P2010" })).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
