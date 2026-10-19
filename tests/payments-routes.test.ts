// =============================================================================
// tests/payments-routes.test.ts — F5 route glue: the master-table export
// (/api/payments/export) and the person autocomplete (/api/payments/users).
//
// Both routes are thin (session → parse → service → serialize), so the test
// mocks exactly their two seams (`getSession` and the db) and asserts the
// contract: staff-only, the two export doors (filter set vs selection), the
// download headers, and that an invalid request never reaches SQL. The
// services' own behavior lives in tests/payments-admin.test.ts and
// tests/dashboard.test.ts; the real `authorization` is kept because for a
// staff actor it is unrestricted and needs no settings read.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));

import { GET as exportGet } from "@/app/api/payments/export/route";
import { GET as usersGet } from "@/app/api/payments/users/route";
import { getSession } from "@/lib/auth/require";
import type { SessionPayload } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { PAYMENTS_EXPORT_MAX_ROWS } from "@/lib/payments-admin";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const PAYMENT = {
  reportId: UUID,
  periodKey: "2026-W42",
  paidAt: new Date(2026, 9, 12, 12, 0, 0),
  reportedAt: new Date(2026, 9, 13, 12, 0, 0),
  userId: "u-1",
  userName: "Ana Pérez",
  userCode: "ANA001",
  level: 1,
  sponsorName: "Raíz",
  sponsorCode: "ROOT01",
  amount: "10.05",
  currency: "USD",
  method: "Transferencia",
  reference: "REF-1",
  status: "APPROVED",
  proofKey: "proof/abc.jpg",
  reviewedByName: "Admin",
  reviewedAt: new Date(2026, 9, 14, 12, 0, 0),
  reviewNote: "ok",
  custom: { cargo: "Diácono" },
};

const USER_OPTION = {
  id: UUID,
  fullName: "Ana Pérez",
  publicCode: "ANA001",
  email: "ana@example.com",
};

const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

function signIn(userId: string | null, role = "ADMIN"): void {
  vi.mocked(getSession).mockResolvedValue(userId ? ({ userId, role } as SessionPayload) : null);
}

function wireDb(
  options: {
    customFields?: unknown[];
    rows?: unknown[];
    selected?: unknown[];
    users?: unknown[];
  } = {},
): void {
  queryRawMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("@dash:custom-fields")) {
      return options.customFields ?? [{ id: "cf-1", code: "cargo", label: "Cargo", fieldType: "TEXT" }];
    }
    if (text.includes("@dash:search-users")) return options.users ?? [USER_OPTION];
    if (text.includes("@payadmin:rows")) return options.rows ?? [PAYMENT];
    if (text.includes("@payadmin:selected")) return options.selected ?? [PAYMENT];
    throw new Error(`unexpected SQL: ${text}`);
  });
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

function callsWith(marker: string): Array<{ text: string; values: unknown[] }> {
  return queryRawMock.mock.calls
    .map((call) => ({
      text: (call[0] as TemplateStringsArray).join("?"),
      values: call.slice(1) as unknown[],
    }))
    .filter((call) => call.text.includes(marker));
}

function exportRequest(query: string): Request {
  return new Request(`https://red.example/api/payments/export${query}`);
}

function usersRequest(query: string): Request {
  return new Request(`https://red.example/api/payments/users${query}`);
}

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  queryRawMock.mockReset();
  wireDb();
});

describe("GET /api/payments/export", () => {
  it("rejects an unauthenticated request with the §10 401 envelope", async () => {
    signIn(null);

    const response = await exportGet(exportRequest("?format=csv"));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("refuses a MEMBER with 403 before any statement runs", async () => {
    signIn("member-1", "MEMBER");

    const response = await exportGet(exportRequest("?format=csv"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("downloads the filtered set as RFC 4180 CSV with the BOM and the fixed columns plus the dashboard ones", async () => {
    signIn("admin-1");

    const response = await exportGet(
      exportRequest(
        `?format=csv&status=APPROVED&minAmount=10&cf_cargo=Diácono` +
          `&userId=${UUID}&userId=${UUID2}&userId=${UUID}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="pagos-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Semana,Fecha de pago,Fecha de reporte,Usuario");
    expect(text).toContain("Ana Pérez");
    expect(text).toContain("Transferencia");
    expect(text).toContain("Aprobado");
    expect(text).toContain("12/10/2026");
    // One dashboard-visible field = one extra column, label in the header and
    // the report's value in the row (D57).
    expect(text).toContain(",Cargo\r\n");
    expect(text).toContain("Diácono");

    // The filters reached SQL: the approved status, the numeric bound and the
    // known custom field (cf_cargo), never as text concatenation.
    const rowsCalls = callsWith("@payadmin:rows");
    expect(rowsCalls).toHaveLength(1);
    const values = flatten(rowsCalls[0].values);
    expect(values).toContain("APPROVED");
    expect(values).toContain("10");
    expect(values).toContain("Diácono");
    // Repeated `userId` params reach SQL as one typed bind per person, deduped
    // (D79): the deep link from /admin/cumplimiento keeps working unchanged.
    expect(values.filter((value) => value === UUID)).toHaveLength(1);
    expect(values).toContain(UUID2);
  });

  it("defaults to a real XLSX workbook when no format is given", async () => {
    signIn("admin-1");

    const response = await exportGet(exportRequest(""));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(XLSX_MIME);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="pagos-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Every .xlsx is a zip: the local file header magic is "PK\x03\x04".
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it("rejects an unsupported format with 400 before any statement runs", async () => {
    signIn("admin-1");

    const response = await exportGet(exportRequest("?format=pdf"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("exports the selection by id and ignores the filters entirely", async () => {
    signIn("admin-1");

    const response = await exportGet(
      exportRequest(`?ids=${UUID}&format=csv&status=REJECTED&cf_cargo=x`),
    );

    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    expect(text).toContain("Ana Pérez");
    expect(text).toContain("Aprobado");
    // The column set is read once for BOTH doors, so the selection export
    // carries the same dashboard columns the table shows (D57)…
    expect(text).toContain(",Cargo\r\n");
    // …while the cf_ filter of the query string was ignored: the selection
    // door never builds a filtered-set statement.
    expect(callsWith("@payadmin:selected")).toHaveLength(1);
    expect(callsWith("@payadmin:rows")).toHaveLength(0);
    expect(callsWith("@dash:custom-fields")).toHaveLength(1);
  });

  it("deduplicates the selection and drops malformed ids before SQL", async () => {
    signIn("admin-1");

    const response = await exportGet(
      exportRequest(`?ids=${UUID}, ,${UUID},not-a-uuid,junk&format=csv`),
    );

    expect(response.status).toBe(200);
    const selectedCalls = callsWith("@payadmin:selected");
    expect(selectedCalls).toHaveLength(1);
    const bound = flatten(selectedCalls[0].values).filter((value) => value === UUID);
    expect(bound).toHaveLength(1);
    expect(flatten(selectedCalls[0].values)).not.toContain("not-a-uuid");
  });

  it("answers 400 for an empty-all-invalid selection instead of exporting everything", async () => {
    signIn("admin-1");

    const response = await exportGet(exportRequest("?ids=,,nope"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("refuses to build a file above the 10 000-row cap with an explanatory 400", async () => {
    signIn("admin-1");
    wireDb({ rows: Array.from({ length: PAYMENTS_EXPORT_MAX_ROWS + 1 }, () => PAYMENT) });

    const response = await exportGet(exportRequest("?format=csv"));

    expect(response.status).toBe(400);
    const envelope = await response.json();
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.message).toContain("10.000");
  });
});

describe("GET /api/payments/users", () => {
  it("rejects an unauthenticated request with the §10 401 envelope", async () => {
    signIn(null);

    const response = await usersGet(usersRequest("?q=ana"));

    expect(response.status).toBe(401);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("refuses a MEMBER with 403 before any statement runs", async () => {
    signIn("member-1", "MEMBER");

    const response = await usersGet(usersRequest("?q=ana"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("returns an empty list for an empty term without touching the database", async () => {
    signIn("admin-1");

    const response = await usersGet(usersRequest(""));

    expect(response.status).toBe(200);
    const envelope = await response.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.data.results).toEqual([]);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("searches people with the default limit and returns the §10 envelope", async () => {
    signIn("admin-1");

    const response = await usersGet(usersRequest("?q=Ana"));

    expect(response.status).toBe(200);
    const envelope = await response.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.data.query).toBe("Ana");
    expect(envelope.data.results).toEqual([USER_OPTION]);

    const calls = callsWith("@dash:search-users");
    expect(calls).toHaveLength(1);
    expect(flatten(calls[0].values)).toEqual(["Ana", "Ana", "Ana", 10]);
  });

  it("rejects a limit above the maximum with 400 before any statement runs", async () => {
    signIn("admin-1");

    const response = await usersGet(usersRequest("?q=Ana&limit=99"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(queryRawMock).not.toHaveBeenCalled();
  });
});
