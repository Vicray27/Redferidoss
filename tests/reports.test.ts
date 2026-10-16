// =============================================================================
// tests/reports.test.ts — §8.4/§8.5 consolidated sheet (F4b).
//
// The fake db routes by `/* @reports:… */` markers; the fake authz returns the
// same duck-typed SQL fragment the real `scopeFilter` produces, so the scope
// assertions prove the fragment is ANDed into the sheet statement and that the
// unrestricted (staff) path embeds nothing.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import { ForbiddenError, type SessionActor } from "../lib/authz";
import { NotFoundError } from "../lib/errors";
import {
  createReportsService,
  dateLabel,
  sharedCurrencyLabel,
  sheetCsv,
  sheetFileName,
  sheetMatrix,
  SHEET_COLUMN_WIDTHS,
  SHEET_HEADERS,
  summarizeSheet,
  type ConsolidatedSheet,
  type ConsolidatedSheetRow,
  type ReportsAuthz,
  type ReportsDb,
} from "../lib/reports";

const STAFF: SessionActor = { userId: "admin-1", role: "ADMIN" };
const MEMBER: SessionActor = { userId: "member-1", role: "MEMBER" };
const NOW = new Date("2026-10-15T12:00:00.000Z");

const CYCLE = {
  id: "cycle-1",
  periodKey: "2026-W42",
  startsAt: new Date("2026-10-12T05:00:00.000Z"),
  endsAt: new Date("2026-10-19T04:59:00.000Z"),
  dueAt: new Date("2026-10-19T04:59:00.000Z"),
  status: "OPEN",
};

/** Local noon: dateLabel is timezone-local, so the label is stable everywhere. */
const PAID_AT = new Date(2026, 9, 12, 12, 0, 0);

type Handler = (values: unknown[]) => unknown;

function isSqlLike(value: unknown): value is { sql: string; values: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { sql?: unknown; values?: unknown };
  return typeof candidate.sql === "string" && Array.isArray(candidate.values);
}

class ReportsFake implements ReportsDb {
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

  /** The innermost non-empty scope fragment embedded in a call, if any. */
  scopeFragmentOf(marker: string): { sql: string; values: unknown[] } | null {
    const scan = (values: unknown[]): { sql: string; values: unknown[] } | null => {
      for (const value of values) {
        if (isSqlLike(value)) {
          const nested = scan(value.values);
          if (nested) return nested;
          if (value.sql.trim() !== "") return value;
        }
      }
      return null;
    };
    for (const call of this.callsFor(marker)) {
      const found = scan(call.values);
      if (found) return found;
    }
    return null;
  }

  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const text = strings.join("?");
    const marker = /\/\* @reports:([\w-]+) \*\//.exec(text)?.[1];
    if (!marker) throw new Error(`ReportsFake: unmarked statement: ${text}`);
    const handler = this.handlers.get(marker);
    if (!handler) throw new Error(`ReportsFake: no handler for ${marker}`);
    this.calls.push({ marker, values });
    return (await handler(values)) as T;
  }
}

function makeAuthz(overrides: { unrestricted?: boolean; fragmentSql?: string } = {}) {
  const scopeCalls: Array<{ actor: unknown; options?: { alias?: string } }> = [];
  const authz: ReportsAuthz = {
    async scopeFilter(actor, options) {
      scopeCalls.push({ actor, options });
      return {
        fragment: {
          sql: overrides.fragmentSql ?? "u.path <@ ?::ltree AND u.depth <= ?",
          values: ["root.abc", 1],
        } as unknown as Prisma.Sql,
        unrestricted: overrides.unrestricted ?? false,
      };
    },
  };
  return { authz, scopeCalls };
}

// --- raw rows the SQL would return ------------------------------------------

const REPORTER = {
  userId: "u-1",
  fullName: "Ana Pérez",
  publicCode: "ANA001",
  level: 1,
  sponsorName: "Raíz",
  sponsorCode: "ROOT01",
  weeklyReportId: "w-1",
  attended: true,
  discipleshipAttended: false,
  cellsTotal: 2,
  cellsHeld: 1,
  cellsNotHeld: 1,
  cellAttendees: 7,
  cellAbsentees: 3,
  cellNewVisitors: 2,
  cellNewCells: 0,
  visitors: ["Luis", "  Marta "],
  note: "buena reunión",
  reportId: "r-1",
  offeringStatus: "APPROVED",
  amount: "10.05",
  currency: "USD",
  method: "TRANSFER",
  paidAt: PAID_AT,
};

/** Obligation-only: owes, never answered (D38's first reading). */
const SILENT = {
  userId: "u-2",
  fullName: "Beto Silva",
  publicCode: "BET002",
  level: 2,
  sponsorName: null,
  sponsorCode: null,
  weeklyReportId: null,
  attended: null,
  discipleshipAttended: null,
  cellsTotal: null,
  cellsHeld: null,
  cellsNotHeld: null,
  cellAttendees: null,
  cellAbsentees: null,
  cellNewVisitors: null,
  cellNewCells: null,
  visitors: null,
  note: null,
  reportId: null,
  offeringStatus: null,
  amount: null,
  currency: null,
  method: null,
  paidAt: null,
};

/** Reported and answered "nothing happened" (D38's second reading). */
const ZERO_ROW = {
  ...SILENT,
  userId: "u-3",
  fullName: "Carla Núñez",
  publicCode: "CAR003",
  level: 2,
  sponsorName: "Ana Pérez",
  sponsorCode: "ANA001",
  weeklyReportId: "w-3",
  attended: false,
  discipleshipAttended: false,
  cellsTotal: 0,
  cellsHeld: 0,
  cellsNotHeld: 0,
  cellAttendees: 0,
  cellAbsentees: 0,
  cellNewVisitors: 0,
  cellNewCells: 0,
  visitors: [],
  reportId: "r-3",
  offeringStatus: "PENDING",
  amount: "0.10",
  currency: "USD",
  method: "CASH",
  paidAt: null,
};

/** A rejected offering still occupies a row (money that must stay visible). */
const REJECTED = {
  ...SILENT,
  userId: "u-4",
  fullName: 'Pérez, "Dora"',
  publicCode: "DOR004",
  level: 3,
  weeklyReportId: "w-4",
  attended: false,
  discipleshipAttended: false,
  cellsTotal: 0,
  cellsHeld: 0,
  cellsNotHeld: 0,
  cellAttendees: 0,
  cellAbsentees: 0,
  cellNewVisitors: 0,
  cellNewCells: 0,
  visitors: [],
  reportId: "r-4",
  offeringStatus: "REJECTED",
  amount: "5.00",
  currency: "USD",
  method: "OTHER",
  paidAt: null,
};

const ALL_ROWS = [REPORTER, SILENT, ZERO_ROW, REJECTED];

function build(rows: unknown[] = ALL_ROWS, overrides: Parameters<typeof makeAuthz>[0] = {}) {
  const db = new ReportsFake();
  const { authz, scopeCalls } = makeAuthz(overrides);

  db.on("list-cycles", () => [CYCLE])
    .on("cycle-by-key", () => [CYCLE])
    .on("current-cycle", () => [CYCLE])
    .on("consolidated-sheet", () => rows);

  const service = createReportsService(db, authz, { now: () => NOW });
  return { db, service, scopeCalls };
}

// -----------------------------------------------------------------------------

describe("listCycles", () => {
  it("lists cycles newest first with the default page size", async () => {
    const { db, service } = build();

    const cycles = await service.listCycles();

    expect(cycles).toEqual([CYCLE]);
    expect(db.valuesOf("list-cycles").at(-1)).toBe(52);
  });

  it("clamps a requested limit into 1..104", async () => {
    const { db, service } = build();

    await service.listCycles({ limit: 500 });
    expect(db.valuesOf("list-cycles").at(-1)).toBe(104);

    db.calls.length = 0;
    await service.listCycles({ limit: 0 });
    expect(db.valuesOf("list-cycles").at(-1)).toBe(1);
  });
});

describe("getConsolidatedSheet", () => {
  it("refuses a MEMBER before any statement runs (D39)", async () => {
    const { db, service, scopeCalls } = build();

    await expect(service.getConsolidatedSheet(MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.calls).toHaveLength(0);
    expect(scopeCalls).toHaveLength(0);
  });

  it("resolves the effective cycle for now()", async () => {
    const { db, service } = build();

    const sheet = await service.getConsolidatedSheet(STAFF);

    expect(sheet.cycle).toEqual(CYCLE);
    expect(db.valuesOf("current-cycle")).toContain(NOW);
    expect(db.callsFor("cycle-by-key")).toHaveLength(0);
  });

  it("resolves an explicit period key and reports 404 for an unknown one", async () => {
    const { db, service } = build();

    await service.getConsolidatedSheet(STAFF, { periodKey: "2026-W41" });
    expect(db.valuesOf("cycle-by-key").at(-1)).toBe("2026-W41");

    const sheetCallsBefore = db.callsFor("consolidated-sheet").length;
    db.on("cycle-by-key", () => []);
    await expect(
      service.getConsolidatedSheet(STAFF, { periodKey: "1999-W01" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(db.callsFor("consolidated-sheet")).toHaveLength(sheetCallsBefore);
  });

  it("reports 404 when no cycle exists at all", async () => {
    const { db, service } = build();
    db.on("current-cycle", () => []);

    await expect(service.getConsolidatedSheet(STAFF)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ANDs the scope fragment into the statement and names the alias `u`", async () => {
    const { db, service, scopeCalls } = build();

    await service.getConsolidatedSheet(STAFF);

    expect(scopeCalls).toHaveLength(1);
    expect(scopeCalls[0]?.options?.alias).toBe("u");
    const fragment = db.scopeFragmentOf("consolidated-sheet");
    expect(fragment?.sql).toContain("u.path <@");
    expect(fragment?.values).toEqual(["root.abc", 1]);
  });

  it("embeds nothing when the scope is unrestricted (staff today)", async () => {
    const { db, service } = build(ALL_ROWS, { unrestricted: true });

    await service.getConsolidatedSheet(STAFF);

    expect(db.scopeFragmentOf("consolidated-sheet")).toBeNull();
    // The cycle is still bound three times: weekly join, lateral offering, EXISTS.
    const values = db.valuesOf("consolidated-sheet");
    expect(values.filter((value) => value === CYCLE.id)).toHaveLength(3);
  });

  it("maps the three D38 states and the offering columns", async () => {
    const { service } = build();

    const sheet = await service.getConsolidatedSheet(STAFF);
    const [reporter, silent, zero, rejected] = sheet.rows;

    expect(reporter?.reported).toBe(true);
    expect(reporter?.noActivity).toBe(false);
    expect(reporter?.attended).toBe(true);
    expect(reporter?.cellsHeld).toBe(1);
    expect(reporter?.visitors).toEqual(["Luis", "Marta"]);
    expect(reporter?.offeringState).toBe("APPROVED");
    expect(reporter?.method).toBe("TRANSFER");
    expect(reporter?.paidAt).toBe(PAID_AT);

    expect(silent?.reported).toBe(false);
    expect(silent?.noActivity).toBe(false);
    expect(silent?.offeringState).toBe("NONE");

    expect(zero?.reported).toBe(true);
    expect(zero?.noActivity).toBe(true);
    expect(zero?.offeringState).toBe("PENDING");

    expect(rejected?.reported).toBe(true);
    expect(rejected?.noActivity).toBe(true);
    expect(rejected?.offeringState).toBe("REJECTED");
    expect(rejected?.amount).toBe("5.00");
  });

  it("derives the totals from the same rows the table renders (D48)", async () => {
    const { service } = build();

    const sheet = await service.getConsolidatedSheet(STAFF);

    expect(sheet.totals).toEqual({
      people: 4,
      reported: 3,
      notReported: 1,
      attended: 1,
      offered: 2, // APPROVED + PENDING; REJECTED is not an offering
      amountTotal: "10.15", // 10.05 + 0.10, exact cents — never 10.1499…
      amountApproved: "10.05",
      visitors: 2,
    });
  });
});

describe("summarizeSheet", () => {
  it("sums BigInt cents exactly across odd amounts", () => {
    const base: ConsolidatedSheetRow = {
      userId: "u",
      fullName: "n",
      publicCode: "c",
      level: 0,
      sponsorName: null,
      sponsorCode: null,
      reported: true,
      noActivity: false,
      attended: false,
      discipleshipAttended: false,
      cellsTotal: 0,
      cellsHeld: 0,
      cellsNotHeld: 0,
      cellAttendees: 0,
      cellAbsentees: 0,
      cellNewVisitors: 0,
      cellNewCells: 0,
      visitors: [],
      note: null,
      offeringState: "APPROVED",
      amount: "0.10",
      currency: "USD",
      method: "CASH",
      paidAt: null,
    };
    const second: ConsolidatedSheetRow = { ...base, userId: "u2", offeringState: "PENDING", amount: "10.05" };
    const rejected: ConsolidatedSheetRow = { ...base, userId: "u3", offeringState: "REJECTED", amount: "99.99" };

    const totals = summarizeSheet([base, second, rejected]);

    expect(totals.amountTotal).toBe("10.15");
    expect(totals.amountApproved).toBe("0.10");
    expect(totals.offered).toBe(2);
  });
});

describe("sheetMatrix", () => {
  it("keeps one cell per header on every row and labels the three D38 states", async () => {
    const { service } = build();
    const matrix = sheetMatrix(await service.getConsolidatedSheet(STAFF));

    expect(matrix.headers).toBe(SHEET_HEADERS);
    expect(matrix.rows).toHaveLength(ALL_ROWS.length);
    for (const row of matrix.rows) {
      expect(row).toHaveLength(SHEET_HEADERS.length);
    }

    const reporte = SHEET_HEADERS.indexOf("Reporte");
    expect(matrix.rows[0]?.[reporte]).toBe("Reportó");
    expect(matrix.rows[1]?.[reporte]).toBe("No reportó");
    expect(matrix.rows[2]?.[reporte]).toBe("Sin actividad");

    // Silent rows answer nothing in the counters, not "0".
    const cellsHeld = SHEET_HEADERS.indexOf("Realizadas");
    expect(matrix.rows[1]?.[cellsHeld]).toBe("—");
    expect(matrix.rows[0]?.[cellsHeld]).toBe("1");

    const asistio = SHEET_HEADERS.indexOf("Asistió");
    expect(matrix.rows[0]?.[asistio]).toBe("Sí");
    expect(matrix.rows[2]?.[asistio]).toBe("No");
    expect(matrix.rows[1]?.[asistio]).toBe("—");

    const visitantes = SHEET_HEADERS.indexOf("Visitantes");
    expect(matrix.rows[0]?.[visitantes]).toBe("2");
    expect(matrix.rows[1]?.[visitantes]).toBe("—");
    const nombres = SHEET_HEADERS.indexOf("Nombres de visitantes");
    expect(matrix.rows[0]?.[nombres]).toBe("Luis; Marta");

    const patrocinador = SHEET_HEADERS.indexOf("Patrocinador");
    expect(matrix.rows[0]?.[patrocinador]).toBe("Raíz");
    expect(matrix.rows[1]?.[patrocinador]).toBe("—");

    const ofrenda = SHEET_HEADERS.indexOf("Ofrenda");
    expect(matrix.rows[3]?.[ofrenda]).toBe("Rechazada");
    const metodo = SHEET_HEADERS.indexOf("Método");
    expect(matrix.rows[0]?.[metodo]).toBe("Transferencia");
    expect(matrix.rows[3]?.[metodo]).toBe("Otro");
    const fecha = SHEET_HEADERS.indexOf("Fecha de pago");
    expect(matrix.rows[0]?.[fecha]).toBe("12/10/2026");
    expect(matrix.rows[1]?.[fecha]).toBe("—");
  });

  it("keeps one width per header", () => {
    expect(SHEET_COLUMN_WIDTHS).toHaveLength(SHEET_HEADERS.length);
  });
});

describe("sheetCsv", () => {
  it("writes RFC 4180 CSV with BOM, CRLF and quoted fields", async () => {
    const { service } = build();
    const matrix = sheetMatrix(await service.getConsolidatedSheet(STAFF));

    const csv = sheetCsv(matrix);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toHaveLength(matrix.rows.length + 2); // + header, + trailing ""
    expect(lines[0]).toBe(SHEET_HEADERS.join(","));
    // The comma-and-quote name is quoted, its quotes doubled (RFC 4180).
    expect(csv).toContain('"Pérez, ""Dora"""');
  });
});

describe("sharedCurrencyLabel", () => {
  async function sheetOf(rows: unknown[]): Promise<ConsolidatedSheet> {
    const { service } = build(rows);
    return service.getConsolidatedSheet(STAFF);
  }

  it("names the currency when every live amount shares one", async () => {
    const sheet = await sheetOf(ALL_ROWS);
    // REPORTER (APPROVED, USD) + ZERO_ROW (PENDING, USD); REJECTED's USD does not count.
    expect(sharedCurrencyLabel(sheet)).toBe("USD");
  });

  it("says «varias monedas» when a mid-week change mixed them", async () => {
    const sheet = await sheetOf([
      REPORTER,
      { ...ZERO_ROW, currency: "VES" },
      SILENT,
    ]);
    expect(sharedCurrencyLabel(sheet)).toBe("varias monedas");
  });

  it("returns null when no live amount exists", async () => {
    const sheet = await sheetOf([SILENT, REJECTED]);
    expect(sharedCurrencyLabel(sheet)).toBeNull();
  });
});

describe("dateLabel / sheetFileName", () => {
  it("formats dates as DD/MM/YYYY", () => {
    expect(dateLabel(new Date(2026, 0, 5, 12, 0, 0))).toBe("05/01/2026");
  });

  it("names the export after the period key", () => {
    expect(sheetFileName("2026-W42", "xlsx")).toBe("planilla-2026-W42.xlsx");
    expect(sheetFileName("2026-W42", "csv")).toBe("planilla-2026-W42.csv");
  });
});
