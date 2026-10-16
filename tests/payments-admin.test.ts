// =============================================================================
// tests/payments-admin.test.ts — §8.5 master table: filters, pagination,
// export caps and the export matrix (F5, D51).
//
// The fake db routes by `/* @payadmin:… */` markers. Value assertions run on
// a deep flatten that walks through embedded Sql fragments, so they check the
// real parameter stream a query would send to Postgres.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import { ForbiddenError, type SessionActor } from "../lib/authz";
import { ValidationError } from "../lib/errors";
import {
  createPaymentsAdminService,
  hasActiveFilters,
  parsePaymentsFilters,
  PAYMENTS_EXPORT_MAX_ROWS,
  PAYMENTS_HEADERS,
  PAYMENTS_PAGE_SIZE_DEFAULT,
  PAYMENTS_PAGE_SIZE_MAX,
  paymentsFileBase,
  paymentsMatrix,
  type PaymentRow,
  type PaymentsAdminAuthz,
  type PaymentsAdminDb,
  type PaymentsAdminFilters,
  type SearchParamsLike,
} from "../lib/payments-admin";

const STAFF: SessionActor = { userId: "admin-1", role: "ADMIN" };
const MEMBER: SessionActor = { userId: "member-1", role: "MEMBER" };

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

type Handler = (values: unknown[]) => unknown;

class PaymentsAdminFake implements PaymentsAdminDb {
  readonly calls: Array<{ marker: string; values: unknown[] }> = [];
  private readonly handlers = new Map<string, Handler>();

  on(marker: string, handler: Handler): this {
    this.handlers.set(marker, handler);
    return this;
  }

  callsFor(marker: string): Array<{ marker: string; values: unknown[] }> {
    return this.calls.filter((call) => call.marker === marker);
  }

  valuesOf(marker: string): unknown[] {
    return this.callsFor(marker)[0]?.values ?? [];
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @payadmin:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`PaymentsAdminFake: unmarked statement: ${text}`);
    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`PaymentsAdminFake: no handler for ${marker}`);
    this.calls.push({ marker, values });
    return (await handler(values)) as T;
  }
}

function isSqlLike(value: unknown): value is { sql: string; values: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { sql?: unknown; values?: unknown };
  return typeof candidate.sql === "string" && Array.isArray(candidate.values);
}

/** Every scalar bound by a query, walking nested Sql fragments. */
function flatten(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    if (isSqlLike(value)) out.push(...flatten(value.values));
    else out.push(value);
  }
  return out;
}

/** Every SQL string embedded in a query, nested fragments included. */
function collectSql(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (isSqlLike(value)) {
      out.push(value.sql);
      out.push(...collectSql(value.values));
    }
  }
  return out;
}

function makeAuthz(overrides: { unrestricted?: boolean; fragmentSql?: string } = {}) {
  const scopeCalls: Array<{ actor: unknown; options?: { alias?: string } }> = [];
  const authz: PaymentsAdminAuthz = {
    async scopeFilter(actor, options) {
      scopeCalls.push({ actor, options });
      return {
        fragment: {
          sql: overrides.fragmentSql ?? "u.path <@ ?::ltree",
          values: ["root.x"],
        } as unknown as Prisma.Sql,
        unrestricted: overrides.unrestricted ?? true,
      };
    },
  };
  return { authz, scopeCalls };
}

function params(entries: Record<string, string | string[]> = {}): SearchParamsLike {
  const all: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) all.push([name, item]);
  }
  return {
    get: (name) => all.find(([key]) => key === name)?.[1] ?? null,
    getAll: (name) => all.filter(([key]) => key === name).map(([, item]) => item),
  };
}

function row(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    reportId: "r-1",
    periodKey: "2026-W42",
    paidAt: new Date(2026, 9, 12, 12, 0, 0),
    reportedAt: new Date(2026, 9, 12, 18, 30, 0),
    userId: U1,
    userName: "Ana Pérez",
    userCode: "ANA001",
    level: 1,
    sponsorName: "Raíz",
    sponsorCode: "ROOT01",
    amount: "150.00",
    currency: "BOB",
    method: "Transferencia",
    reference: "REF-1",
    status: "PENDING",
    proofKey: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    ...overrides,
  };
}

function withRows(rows: PaymentRow[], total = rows.length): PaymentsAdminFake {
  return new PaymentsAdminFake()
    .on("count", () => [{ total }])
    .on("rows", () => rows)
    .on("selected", () => rows);
}

// --- parsing -----------------------------------------------------------------

describe("parsePaymentsFilters", () => {
  it("returns safe defaults for an empty query", () => {
    const filters = parsePaymentsFilters(params());
    expect(filters).toEqual({
      cycles: [],
      dateField: "reported_at",
      dateFrom: null,
      dateTo: null,
      status: null,
      userId: null,
      subtreeOf: null,
      levelMin: null,
      levelMax: null,
      methodId: null,
      minAmount: null,
      maxAmount: null,
      currency: null,
      proofs: null,
      q: null,
      customFields: [],
      page: 1,
      pageSize: PAYMENTS_PAGE_SIZE_DEFAULT,
    });
    expect(hasActiveFilters(filters)).toBe(false);
  });

  it("reads multi-select cycles from repeated params", () => {
    const filters = parsePaymentsFilters(params({ cycles: ["2026-W42", " 2026-W41 ", ""] }));
    expect(filters.cycles).toEqual(["2026-W42", "2026-W41"]);
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it("honors paid_at as the date field and swaps a reversed range", () => {
    const filters = parsePaymentsFilters(
      params({ dateField: "paid_at", dateFrom: "2026-10-19", dateTo: "2026-10-12" }),
    );
    expect(filters.dateField).toBe("paid_at");
    expect(filters.dateFrom).toEqual(new Date(Date.UTC(2026, 9, 12)));
    expect(filters.dateTo).toEqual(new Date(Date.UTC(2026, 9, 19)));
  });

  it("drops impossible calendar days and garbage dates", () => {
    expect(parsePaymentsFilters(params({ dateFrom: "2026-02-31" })).dateFrom).toBeNull();
    expect(parsePaymentsFilters(params({ dateTo: "ayer" })).dateTo).toBeNull();
    expect(parsePaymentsFilters(params({ dateFrom: "2026-1-2" })).dateFrom).toBeNull();
  });

  it("keeps a valid status and discards anything else", () => {
    expect(parsePaymentsFilters(params({ status: "APPROVED" })).status).toBe("APPROVED");
    expect(parsePaymentsFilters(params({ status: "PAID" })).status).toBeNull();
  });

  it("only accepts uuid-shaped user, subtree and method ids", () => {
    const filters = parsePaymentsFilters(
      params({ userId: U1, subtreeOf: "not-a-uuid", methodId: U2.toUpperCase() }),
    );
    expect(filters.userId).toBe(U1);
    expect(filters.subtreeOf).toBeNull();
    expect(filters.methodId).toBe(U2);
  });

  it("normalizes the level range", () => {
    expect(parsePaymentsFilters(params({ levelMin: "3" })).levelMin).toBe(3);
    // Reversed range swaps into min/max instead of matching nothing.
    const swapped = parsePaymentsFilters(params({ levelMin: "7", levelMax: "2" }));
    expect([swapped.levelMin, swapped.levelMax]).toEqual([2, 7]);
    // Out-of-domain levels are dropped.
    expect(parsePaymentsFilters(params({ levelMin: "100", levelMax: "x" })).levelMin).toBeNull();
    expect(parsePaymentsFilters(params({ levelMax: "-1" })).levelMax).toBeNull();
  });

  it("only binds well-formed decimal amounts", () => {
    expect(parsePaymentsFilters(params({ minAmount: "0" })).minAmount).toBe("0");
    expect(parsePaymentsFilters(params({ minAmount: "10.50" })).minAmount).toBe("10.50");
    expect(parsePaymentsFilters(params({ minAmount: "10.555" })).minAmount).toBeNull();
    expect(parsePaymentsFilters(params({ minAmount: "-1" })).minAmount).toBeNull();
    expect(parsePaymentsFilters(params({ minAmount: "1e3" })).minAmount).toBeNull();
    expect(parsePaymentsFilters(params({ minAmount: ".5" })).minAmount).toBeNull();
  });

  it("uppercases a three-letter currency and drops the rest", () => {
    expect(parsePaymentsFilters(params({ currency: "bob" })).currency).toBe("BOB");
    expect(parsePaymentsFilters(params({ currency: "BO" })).currency).toBeNull();
  });

  it("accepts yes/no for the proof filter", () => {
    expect(parsePaymentsFilters(params({ proofs: "yes" })).proofs).toBe("yes");
    expect(parsePaymentsFilters(params({ proofs: "no" })).proofs).toBe("no");
    expect(parsePaymentsFilters(params({ proofs: "maybe" })).proofs).toBeNull();
  });

  it("trims and caps the free-text term", () => {
    expect(parsePaymentsFilters(params({ q: "  ref  " })).q).toBe("ref");
    expect(parsePaymentsFilters(params({ q: "  " })).q).toBeNull();
    expect(parsePaymentsFilters(params({ q: "x".repeat(300) })).q).toHaveLength(120);
  });

  it("honors cf_ params only for dashboard custom fields", () => {
    const filters = parsePaymentsFilters(
      params({ cf_banco: "Santander", cf_secreto: "x", cf_vacio: "" }),
      { customFieldCodes: ["banco", "vacio"] },
    );
    expect(filters.customFields).toEqual([{ code: "banco", value: "Santander" }]);
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it("bounds page and page_size", () => {
    expect(parsePaymentsFilters(params({ page: "3", page_size: "100" }))).toMatchObject({
      page: 3,
      pageSize: 100,
    });
    expect(parsePaymentsFilters(params({ page: "0", page_size: "abc" }))).toMatchObject({
      page: 1,
      pageSize: PAYMENTS_PAGE_SIZE_DEFAULT,
    });
    expect(parsePaymentsFilters(params({ page_size: "9999" })).pageSize).toBe(PAYMENTS_PAGE_SIZE_MAX);
  });
});

// --- service -----------------------------------------------------------------

describe("listPayments", () => {
  it("refuses a MEMBER before any SQL runs", async () => {
    const fake = withRows([row()]);
    const { authz } = makeAuthz();
    const service = createPaymentsAdminService(fake, authz);
    await expect(
      service.listPayments(MEMBER, parsePaymentsFilters(params())),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.calls).toHaveLength(0);
  });

  it("asks for the count and the page in parallel and returns the paginator", async () => {
    const fake = withRows([row(), row({ reportId: "r-2" })], 123);
    const { authz, scopeCalls } = makeAuthz();
    const service = createPaymentsAdminService(fake, authz);

    const filters = parsePaymentsFilters(params({ page: "2", page_size: "50" }));
    const page = await service.listPayments(STAFF, filters);

    expect(scopeCalls[0].options).toEqual({ alias: "u" });
    expect(fake.callsFor("count")).toHaveLength(1);
    expect(fake.callsFor("rows")).toHaveLength(1);
    // page 2 of 50 rows: LIMIT 50 OFFSET 50, both bound inside fragments.
    const scalars = flatten(fake.valuesOf("rows"));
    expect(scalars).toContain(50);
    expect(scalars.filter((value) => value === 50)).toHaveLength(2);
    expect(page).toMatchObject({ page: 2, perPage: 50, total: 123, totalPages: 3 });
    expect(page.items).toHaveLength(2);
  });

  it("binds every filter as a parameter, never as text", async () => {
    const fake = withRows([]);
    const { authz } = makeAuthz();
    const service = createPaymentsAdminService(fake, authz);

    const filters = parsePaymentsFilters(
      params({
        cycles: ["2026-W42"],
        dateField: "paid_at",
        dateFrom: "2026-10-01",
        dateTo: "2026-10-15",
        status: "PENDING",
        userId: U1,
        subtreeOf: U2,
        levelMin: "1",
        levelMax: "4",
        methodId: U1,
        minAmount: "10",
        maxAmount: "500.50",
        currency: "usd",
        proofs: "yes",
        q: "ref",
      }),
      { customFieldCodes: ["banco"] },
    );
    filters.customFields = [{ code: "banco", value: "BCP" }];
    await service.listPayments(STAFF, filters);

    const scalars = flatten(fake.valuesOf("rows"));
    for (const expected of [
      "2026-W42",
      filters.dateFrom,
      new Date(filters.dateTo!.getTime() + 24 * 60 * 60 * 1000),
      "PENDING",
      U1,
      U2,
      1,
      4,
      "10",
      "500.50",
      "USD",
      "ref",
      "banco",
      "BCP",
    ]) {
      expect(scalars).toContainEqual(expected);
    }
    // The paid_at column choice is a whitelisted raw fragment, not a binding.
    expect(collectSql(fake.valuesOf("rows")).join(" ")).toContain("r.paid_at");
    // Proofs yes -> IS NULL check happens in SQL, not by binding a flag.
    expect(collectSql(fake.valuesOf("rows")).join(" ")).toContain("proof_key IS NOT NULL");
  });

  it("embeds the scope fragment for a restricted actor and nothing for staff", async () => {
    const restricted = withRows([]);
    const restrictedAuthz = makeAuthz({
      unrestricted: false,
      fragmentSql: "u.path <@ ?::ltree",
    });
    await createPaymentsAdminService(restricted, restrictedAuthz.authz).listPayments(
      STAFF,
      parsePaymentsFilters(params()),
    );
    expect(flatten(restricted.valuesOf("rows"))).toContain("root.x");

    const unrestricted = withRows([]);
    const staffAuthz = makeAuthz({ unrestricted: true });
    await createPaymentsAdminService(unrestricted, staffAuthz.authz).listPayments(
      STAFF,
      parsePaymentsFilters(params()),
    );
    expect(collectSql(unrestricted.valuesOf("rows")).join(" ")).not.toContain("<@");
  });
});

describe("exportRows / selectedRows", () => {
  it("returns rows under the cap and refuses above it", async () => {
    const { authz } = makeAuthz();
    const small = withRows([row()]);
    await expect(
      createPaymentsAdminService(small, authz).exportRows(STAFF, parsePaymentsFilters(params())),
    ).resolves.toHaveLength(1);
    // The read itself asks for cap + 1 rows.
    expect(flatten(small.valuesOf("rows"))).toContain(PAYMENTS_EXPORT_MAX_ROWS + 1);

    const big = withRows(
      Array.from({ length: PAYMENTS_EXPORT_MAX_ROWS + 1 }, (_, index) =>
        row({ reportId: `r-${index}` }),
      ),
    );
    await expect(
      createPaymentsAdminService(big, authz).exportRows(STAFF, parsePaymentsFilters(params())),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("dedupes selection ids, drops malformed ones and requires at least one", async () => {
    const { authz } = makeAuthz();
    const fake = withRows([row()]);
    const service = createPaymentsAdminService(fake, authz);

    await expect(service.selectedRows(STAFF, ["nope", "  "])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fake.calls).toHaveLength(0);

    await service.selectedRows(STAFF, [U1, U1, "nope", U2]);
    expect(flatten(fake.valuesOf("selected"))).toEqual([U1, U2]);
  });

  it("refuses a selection above the export cap before touching SQL", async () => {
    const { authz } = makeAuthz();
    const fake = withRows([]);
    const ids = Array.from(
      { length: PAYMENTS_EXPORT_MAX_ROWS + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await expect(
      createPaymentsAdminService(fake, authz).selectedRows(STAFF, ids),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });
});

// --- export matrix -----------------------------------------------------------

describe("paymentsMatrix", () => {
  it("renders the sixteen §8.5 columns with Spanish labels and dash placeholders", () => {
    expect(PAYMENTS_HEADERS).toHaveLength(16);
    const [first] = paymentsMatrix([row()]);
    expect(first).toHaveLength(16);
    expect(first).toEqual([
      "2026-W42",
      "12/10/2026",
      "12/10/2026",
      "Ana Pérez",
      "ANA001",
      "1",
      "Raíz",
      "150.00",
      "BOB",
      "Transferencia",
      "REF-1",
      "Pendiente",
      "No",
      "-",
      "-",
      "-",
    ]);
  });

  it("marks a reviewed, receipted and approved row", () => {
    const [cells] = paymentsMatrix([
      row({
        status: "APPROVED",
        proofKey: "files/abc",
        reviewedByName: "Root",
        reviewedAt: new Date(2026, 9, 13, 9, 0, 0),
        reviewNote: "OK",
        reference: null,
        method: null,
      }),
    ]);
    expect(cells[10]).toBe("-");
    expect(cells[11]).toBe("Aprobado");
    expect(cells[12]).toBe("Sí");
    expect(cells[13]).toBe("Root");
    expect(cells[14]).toBe("13/10/2026");
    expect(cells[15]).toBe("OK");
  });
});

describe("paymentsFileBase", () => {
  it("stamps the UTC day for a stable file name", () => {
    expect(paymentsFileBase(new Date("2026-10-15T23:59:00.000Z"))).toBe("pagos-2026-10-15");
  });
});
