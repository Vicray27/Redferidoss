import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/admin/reports/export is glue (session → query → service → file), so
 * the test mocks exactly its two seams (`getSession` and the db) and asserts
 * the contract: staff-only, the two formats, the download headers, and that an
 * invalid request never reaches SQL. The service's own behavior lives in
 * tests/reports.test.ts; the real `authorization` is kept because for a staff
 * actor it is unrestricted and needs no settings read.
 */

vi.mock("@/lib/auth/require", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));

import { GET } from "@/app/api/admin/reports/export/route";
import { getSession } from "@/lib/auth/require";
import type { SessionPayload } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const PAID_AT = new Date(2026, 9, 12, 12, 0, 0);

const CYCLE = {
  id: "cycle-1",
  periodKey: "2026-W42",
  startsAt: new Date("2026-10-12T05:00:00.000Z"),
  endsAt: new Date("2026-10-19T04:59:00.000Z"),
  dueAt: new Date("2026-10-19T04:59:00.000Z"),
  status: "OPEN",
};

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
  visitors: ["Luis"],
  note: "buena reunión",
  reportId: "r-1",
  offeringStatus: "APPROVED",
  amount: "10.05",
  currency: "USD",
  method: "TRANSFER",
  paidAt: PAID_AT,
};

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

const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

function signIn(userId: string | null, role = "ADMIN"): void {
  vi.mocked(getSession).mockResolvedValue(userId ? ({ userId, role } as SessionPayload) : null);
}

function wireDb(options: { cycleByKey?: unknown[]; sheetRows?: unknown[] } = {}): void {
  queryRawMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("@reports:cycle-by-key")) return options.cycleByKey ?? [CYCLE];
    if (text.includes("@reports:current-cycle")) return [CYCLE];
    if (text.includes("@reports:consolidated-sheet")) return options.sheetRows ?? [REPORTER, SILENT];
    if (text.includes("@reports:list-cycles")) return [CYCLE];
    throw new Error(`unexpected SQL: ${text}`);
  });
}

function exportRequest(query: string): Request {
  return new Request(`https://red.example/api/admin/reports/export${query}`);
}

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  queryRawMock.mockReset();
  wireDb();
});

describe("GET /api/admin/reports/export", () => {
  it("rejects an unauthenticated request with the §10 401 envelope", async () => {
    signIn(null);

    const response = await GET(exportRequest("?cycle=2026-W42&format=csv"));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("refuses a MEMBER with 403 before any statement runs", async () => {
    signIn("member-1", "MEMBER");

    const response = await GET(exportRequest("?cycle=2026-W42&format=csv"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("downloads the CSV of the requested week with the download headers", async () => {
    signIn("admin-1");

    const response = await GET(exportRequest("?cycle=2026-W42&format=csv"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="planilla-2026-W42.csv"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    // `Response.text()` strips a leading BOM, so the BOM contract is pinned on
    // the wire bytes — which is exactly what Excel reads.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Nivel,Nombre");
    expect(text).toContain("Ana Pérez");
    expect(text).toContain("Reportó");
    expect(text).toContain("No reportó");
  });

  it("defaults to XLSX and answers a real zip workbook", async () => {
    signIn("admin-1");

    const response = await GET(exportRequest("?cycle=2026-W42"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(XLSX_MIME);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="planilla-2026-W42.xlsx"');

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Every .xlsx is a zip: the local file header magic is "PK\x03\x04".
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it("falls back to the effective cycle when no week is given", async () => {
    signIn("admin-1");

    const response = await GET(exportRequest("?format=xlsx"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="planilla-2026-W42.xlsx"');
  });

  it("answers 404 for an unknown week without running the sheet statement", async () => {
    signIn("admin-1");
    wireDb({ cycleByKey: [] });

    const response = await GET(exportRequest("?cycle=1999-W01&format=csv"));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
    const sqlTexts = queryRawMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join("?"));
    expect(sqlTexts.some((text) => text.includes("@reports:consolidated-sheet"))).toBe(false);
  });

  it("rejects an unsupported format with 400 before any statement runs", async () => {
    signIn("admin-1");

    const response = await GET(exportRequest("?cycle=2026-W42&format=pdf"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });
});
