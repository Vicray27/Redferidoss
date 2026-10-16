// =============================================================================
// tests/dashboard.test.ts — §8.5 landing: KPIs, chart series and matrix (F5).
//
// The fake db routes by `/* @dash:… */` markers. Every aggregate assertion
// starts from the DECIMAL-string the SQL would return, so these tests pin the
// exact-cents arithmetic (A14) and the display semantics D50/D54 record.
// =============================================================================

import { describe, expect, it } from "vitest";

import { ForbiddenError, type SessionActor } from "../lib/authz";
import { NotFoundError } from "../lib/errors";
import {
  COMPLIANCE_MAX_USERS,
  complianceState,
  createDashboardService,
  resolveWindow,
  sumDecimals,
  type DashboardDb,
} from "../lib/dashboard";

const STAFF: SessionActor = { userId: "admin-1", role: "ADMIN" };
const MEMBER: SessionActor = { userId: "member-1", role: "MEMBER" };
const NOW = new Date("2026-10-15T12:00:00.000Z");

const CYCLE = {
  id: "cycle-42",
  periodKey: "2026-W42",
  startsAt: new Date("2026-10-12T05:00:00.000Z"),
  endsAt: new Date("2026-10-19T04:59:00.000Z"),
  dueAt: new Date("2026-10-19T04:59:00.000Z"),
  status: "OPEN",
};

const PRIOR_CYCLE_START = new Date("2026-10-05T05:00:00.000Z");

type Handler = (values: unknown[]) => unknown;

class DashboardFake implements DashboardDb {
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
    const marker = /\/\* @dash:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`DashboardFake: unmarked statement: ${text}`);
    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`DashboardFake: no handler for ${marker}`);
    this.calls.push({ marker, values });
    return (await handler(values)) as T;
  }
}

function makeService(fake: DashboardFake) {
  // No scopeFilter: dashboard aggregates are staff-global cycle figures, so
  // the service must NOT ask for a row scope fragment (D50). The stub would
  // throw if it did.
  return createDashboardService(fake, {
    async scopeFilter() {
      throw new Error("dashboard must not request a scope fragment");
    },
  }, { now: () => NOW });
}

// --- raw rows the SQL would return ------------------------------------------

const KPI_ROW = {
  approvedTotal: "12345.5",
  reportsCount: 9,
  approvedCount: 3,
  pendingCount: 4,
  obligationsCount: 24,
  missedCount: 2,
  newUsersCount: 5,
  networkSize: 640,
};

const SERIES_ROWS = [
  {
    periodKey: "2026-W42",
    startsAt: CYCLE.startsAt,
    approvedTotal: "100.00",
    reportsCount: 3,
    obligationsCount: 2,
  },
  {
    periodKey: "2026-W41",
    startsAt: PRIOR_CYCLE_START,
    approvedTotal: "50.5",
    reportsCount: 1,
    obligationsCount: 5,
  },
];

function overviewFake(): DashboardFake {
  return new DashboardFake()
    .on("current-cycle", () => [CYCLE])
    .on("cycle-by-key", () => [CYCLE])
    .on("kpis", () => [KPI_ROW])
    .on("weekly-series", () => SERIES_ROWS)
    .on("level-contribution", () => [
      { level: 1, total: "60.00", reports: 2 },
      { level: 2, total: "40.5", reports: 1 },
    ])
    .on("top-contributors", () => [
      { userId: "u-1", fullName: "Ana Pérez", publicCode: "ANA001", level: 1, total: "60.00", reports: 2 },
    ])
    .on("top-sponsors", () => [
      { userId: "s-1", fullName: "Raíz", publicCode: "ROOT01", total: "75.25", reports: 4 },
    ])
    .on("heatmap", () => [
      { periodKey: "2026-W41", level: 2, approved: 3, obligations: 5 },
      { periodKey: "2026-W42", level: 1, approved: 1, obligations: 2 },
      { periodKey: "2026-W42", level: 2, approved: 4, obligations: 6 },
    ]);
}

// --- guards ------------------------------------------------------------------

describe("staff guard", () => {
  const staffOnly = [
    ["getOverview", (service: ReturnType<typeof makeService>) => service.getOverview(MEMBER)],
    ["getCompliance", (service: ReturnType<typeof makeService>) => service.getCompliance(MEMBER)],
    ["searchUsers", (service: ReturnType<typeof makeService>) => service.searchUsers(MEMBER, "ana")],
    ["userOption", (service: ReturnType<typeof makeService>) => service.userOption(MEMBER, "u-1")],
    [
      "listDashboardCustomFields",
      (service: ReturnType<typeof makeService>) => service.listDashboardCustomFields(MEMBER),
    ],
    ["listPaymentMethods", (service: ReturnType<typeof makeService>) => service.listPaymentMethods(MEMBER)],
  ] as const;

  for (const [name, call] of staffOnly) {
    it(`${name} throws ForbiddenError for a MEMBER without touching SQL`, async () => {
      const fake = overviewFake();
      await expect(call(makeService(fake))).rejects.toBeInstanceOf(ForbiddenError);
      expect(fake.calls).toHaveLength(0);
    });
  }
});

// --- resolveWindow -----------------------------------------------------------

describe("resolveWindow", () => {
  it("accepts the supported windows and falls back on anything else", () => {
    expect(resolveWindow("12", [12, 26, 52], 12)).toBe(12);
    expect(resolveWindow("26", [12, 26, 52], 12)).toBe(26);
    expect(resolveWindow(52, [12, 26, 52], 12)).toBe(52);
    expect(resolveWindow("13", [12, 26, 52], 12)).toBe(12);
    expect(resolveWindow(undefined, [12, 26, 52], 12)).toBe(12);
    expect(resolveWindow("abril", [12, 26, 52], 12)).toBe(12);
  });
});

// --- getOverview -------------------------------------------------------------

describe("getOverview", () => {
  it("reads the current cycle and answers the eight KPIs with exact cents", async () => {
    const fake = overviewFake();
    const overview = await makeService(fake).getOverview(STAFF);

    // The three OR/WHERE occurrences of `now()` bind as three parameters.
    expect(fake.valuesOf("current-cycle")).toEqual([NOW, NOW, NOW]);
    expect(fake.callsFor("cycle-by-key")).toHaveLength(0);

    expect(overview.kpis).toEqual({
      collectedTotal: "12345.50",
      reportsCount: 9,
      // 1234550n / 3n truncates toward zero: 411516 → 4115.16.
      averageTicket: "4115.16",
      complianceRate: 0.125,
      pendingCount: 4,
      missedCount: 2,
      newUsersCount: 5,
      networkSize: 640,
    });
    expect(overview.cycle).toEqual(CYCLE);
    expect(overview.weeks).toBe(12);
  });

  it("passes the window to the series and heatmap queries", async () => {
    const fake = overviewFake();
    await makeService(fake).getOverview(STAFF, { weeks: 26 });

    expect(fake.valuesOf("weekly-series")).toEqual([CYCLE.startsAt, 26]);
    expect(fake.valuesOf("heatmap")).toEqual([CYCLE.startsAt, 26]);
  });

  it("returns the series oldest-first and the heatmap keys in the same order", async () => {
    const fake = overviewFake();
    const overview = await makeService(fake).getOverview(STAFF);

    expect(overview.weeklySeries.map((point) => point.periodKey)).toEqual(["2026-W41", "2026-W42"]);
    expect(overview.heatmap.periodKeys).toEqual(["2026-W41", "2026-W42"]);
    // Levels deduped and ascending; cells pass through untouched.
    expect(overview.heatmap.levels).toEqual([1, 2]);
    expect(overview.heatmap.cells).toHaveLength(3);
  });

  it("resolves an explicit period and never asks for the current cycle", async () => {
    const fake = overviewFake();
    await makeService(fake).getOverview(STAFF, { periodKey: "2026-W41" });

    expect(fake.valuesOf("cycle-by-key")).toEqual(["2026-W41"]);
    expect(fake.callsFor("current-cycle")).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown period", async () => {
    const fake = overviewFake().on("cycle-by-key", () => []);
    await expect(makeService(fake).getOverview(STAFF, { periodKey: "2030-W01" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFoundError when no cycle exists at all", async () => {
    const fake = overviewFake().on("current-cycle", () => []);
    await expect(makeService(fake).getOverview(STAFF)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("shows a zero ticket when nobody was approved yet", async () => {
    const fake = overviewFake().on("kpis", () => [
      { ...KPI_ROW, approvedTotal: "0", approvedCount: 0, obligationsCount: 0, reportsCount: 0 },
    ]);
    const overview = await makeService(fake).getOverview(STAFF);

    expect(overview.kpis.averageTicket).toBe("0.00");
    expect(overview.kpis.complianceRate).toBe(0);
  });
});

// --- complianceState ---------------------------------------------------------

describe("complianceState", () => {
  const cases: Array<[string, Parameters<typeof complianceState>[0], string]> = [
    [
      "approved report wins over everything",
      { obligationId: "o1", obligationStatus: "MISSED", approved: true, pending: true, rejected: true },
      "approved",
    ],
    [
      "pending report beats a rejected one (resubmission)",
      { obligationId: "o1", obligationStatus: "PENDING", approved: null, pending: true, rejected: true },
      "pending",
    ],
    [
      "only a rejected report means missed",
      { obligationId: "o1", obligationStatus: "PENDING", approved: null, pending: null, rejected: true },
      "missed",
    ],
    [
      "MISSED obligation means missed",
      { obligationId: "o1", obligationStatus: "MISSED", approved: null, pending: null, rejected: null },
      "missed",
    ],
    [
      "EXEMPT obligation means exempt",
      { obligationId: "o1", obligationStatus: "EXEMPT", approved: null, pending: null, rejected: null },
      "exempt",
    ],
    [
      "an open obligation still owes",
      { obligationId: "o1", obligationStatus: "FULFILLED", approved: null, pending: null, rejected: null },
      "pending",
    ],
    [
      "no obligation and no report is exempt",
      { obligationId: null, obligationStatus: null, approved: null, pending: null, rejected: null },
      "exempt",
    ],
  ];

  for (const [name, row, expected] of cases) {
    it(name, () => {
      expect(complianceState(row)).toBe(expected);
    });
  }
});

// --- getCompliance -----------------------------------------------------------

const COMPLIANCE_ROWS = [
  {
    cycleId: "c41",
    periodKey: "2026-W41",
    startsAt: PRIOR_CYCLE_START,
    userId: "u-1",
    fullName: "Ana Pérez",
    publicCode: "ANA001",
    level: 1,
    obligationId: "o-1-41",
    obligationStatus: "FULFILLED",
    approved: true,
    pending: false,
    rejected: false,
  },
  {
    cycleId: "c42",
    periodKey: "2026-W42",
    startsAt: CYCLE.startsAt,
    userId: "u-1",
    fullName: "Ana Pérez",
    publicCode: "ANA001",
    level: 1,
    obligationId: "o-1-42",
    obligationStatus: "PENDING",
    approved: null,
    pending: true,
    rejected: false,
  },
  {
    cycleId: "c41",
    periodKey: "2026-W41",
    startsAt: PRIOR_CYCLE_START,
    userId: "u-2",
    fullName: "Beto Díaz",
    publicCode: "BET002",
    level: 2,
    obligationId: "o-2-41",
    obligationStatus: "MISSED",
    approved: null,
    pending: null,
    rejected: true,
  },
  {
    cycleId: "c41",
    periodKey: "2026-W41",
    startsAt: PRIOR_CYCLE_START,
    userId: "u-3",
    fullName: "Caro Gil",
    publicCode: "CAR003",
    level: 2,
    obligationId: "o-3-41",
    obligationStatus: "EXEMPT",
    approved: null,
    pending: null,
    rejected: null,
  },
];

function complianceFake(rows: unknown[] = COMPLIANCE_ROWS): DashboardFake {
  return new DashboardFake().on("current-cycle", () => [CYCLE]).on("compliance", () => rows);
}

describe("getCompliance", () => {
  it("pages the window and groups the cells per user, in window order", async () => {
    const fake = complianceFake();
    const matrix = await makeService(fake).getCompliance(STAFF);

    // startsAt of the anchor + window + cap+1 candidates.
    expect(fake.valuesOf("compliance")).toEqual([CYCLE.startsAt, 12, COMPLIANCE_MAX_USERS + 1]);
    expect(matrix.weeks).toBe(12);
    expect(matrix.truncated).toBe(false);
    expect(matrix.periodKeys).toEqual(["2026-W41", "2026-W42"]);
    expect(matrix.rows.map((row) => row.fullName)).toEqual(["Ana Pérez", "Beto Díaz", "Caro Gil"]);
    expect(matrix.rows[0].cells).toEqual([
      { periodKey: "2026-W41", state: "approved" },
      { periodKey: "2026-W42", state: "pending" },
    ]);
    // Beto has no row in W42: nothing owed, nothing paid -> exempt.
    expect(matrix.rows[1].cells.map((cell) => cell.state)).toEqual(["missed", "exempt"]);
    expect(matrix.rows[2].cells.map((cell) => cell.state)).toEqual(["exempt", "exempt"]);
  });

  it("accepts the wider windows and rejects unsupported ones", async () => {
    const fake = complianceFake();
    const service = makeService(fake);
    await service.getCompliance(STAFF, { weeks: 26 });
    expect(fake.valuesOf("compliance")[1]).toBe(26);
    await service.getCompliance(STAFF, { weeks: 52 });
    expect(fake.callsFor("compliance")[1].values[1]).toBe(12);
  });

  it("cuts the matrix at the cap and says so", async () => {
    const rows = Array.from({ length: COMPLIANCE_MAX_USERS + 1 }, (_, index) => ({
      cycleId: "c42",
      periodKey: "2026-W42",
      startsAt: CYCLE.startsAt,
      userId: `u-${String(index).padStart(4, "0")}`,
      fullName: `Persona ${index}`,
      publicCode: `P${index}`,
      level: 1,
      obligationId: `o-${index}`,
      obligationStatus: "PENDING",
      approved: null,
      pending: null,
      rejected: null,
    }));
    const matrix = await makeService(complianceFake(rows)).getCompliance(STAFF);

    expect(matrix.rows).toHaveLength(COMPLIANCE_MAX_USERS);
    expect(matrix.truncated).toBe(true);
  });
});

// --- filter support reads ----------------------------------------------------

describe("searchUsers / userOption / catalogs", () => {
  const USERS = [
    { id: "u-1", fullName: "Ana Pérez", publicCode: "ANA001", email: "ana@example.org" },
  ];

  it("short-circuits an empty term without touching SQL", async () => {
    const fake = new DashboardFake().on("search-users", () => USERS);
    expect(await makeService(fake).searchUsers(STAFF, "   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the term and a bounded limit", async () => {
    const fake = new DashboardFake().on("search-users", () => USERS);
    const results = await makeService(fake).searchUsers(STAFF, "ana", { limit: 99 });

    expect(results).toEqual(USERS);
    expect(fake.valuesOf("search-users")).toEqual(["ana", "ana", "ana", 20]);
  });

  it("returns null when the user does not exist", async () => {
    const fake = new DashboardFake().on("user-option", () => []);
    expect(await makeService(fake).userOption(STAFF, "u-404")).toBeNull();
    expect(fake.valuesOf("user-option")).toEqual(["u-404"]);
  });

  it("lists the dashboard custom fields and every method, inactive included", async () => {
    const fields = [{ id: "f-1", code: "banco", label: "Banco", fieldType: "TEXT" }];
    const methods = [{ id: "m-1", code: "TRANSFER", label: "Transferencia", isActive: false }];
    const fake = new DashboardFake()
      .on("custom-fields", () => fields)
      .on("payment-methods", () => methods);

    expect(await makeService(fake).listDashboardCustomFields(STAFF)).toEqual(fields);
    expect(await makeService(fake).listPaymentMethods(STAFF)).toEqual(methods);
  });
});

// --- money helper ------------------------------------------------------------

describe("sumDecimals", () => {
  it("sums exact cents, never floats", () => {
    expect(sumDecimals(["0.10", "0.20"])).toBe("0.30");
    expect(sumDecimals(["1.99", "0.01"])).toBe("2.00");
    expect(sumDecimals([])).toBe("0.00");
  });
});
