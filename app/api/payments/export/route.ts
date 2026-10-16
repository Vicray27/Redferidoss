// =============================================================================
// app/api/payments/export/route.ts — §8.5: download the master payments table.
//
// Two doors, one matrix: the full filtered set (`exportRows`, hard capped at
// PAYMENTS_EXPORT_MAX_ROWS) or the checkbox selection (`selectedRows`,
// addressed by id). Both render `paymentsMatrix` — the same 16 columns the
// screen shows — so the file and the table cannot disagree (D51).
//
// When `ids` is present the filters are IGNORED on purpose: exporting the
// selection must export exactly the selection. An `ids` that parses to nothing
// is a 400 (the service refuses), never a silent fallback to the whole filter
// set — handing over a different ledger than the one asked for is worse than
// an error message.
// =============================================================================

import { z } from "zod";
import writeXlsxFile from "write-excel-file/node";

import { parseQuery, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { createDashboardService } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import {
  createPaymentsAdminService,
  parsePaymentsFilters,
  paymentsFileBase,
  paymentsMatrix,
  PAYMENTS_HEADERS,
} from "@/lib/payments-admin";
import { sheetCsv } from "@/lib/reports";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv; charset=utf-8";

const querySchema = z.object({
  format: z.enum(["xlsx", "csv"]).default("xlsx"),
  // The selection export: comma-separated report ids. The URL is the only
  // channel, so the cap here is a string-length sanity check; the per-item
  // validation and the row cap live in `selectedRows`.
  ids: z.string().max(100_000).optional(),
});

/** Screen and files share the matrix; these widths only shape the workbook. */
const PAYMENTS_COLUMN_WIDTHS = [12, 12, 12, 24, 12, 6, 20, 12, 8, 14, 20, 11, 11, 18, 12, 28];

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const query = parseQuery(request, querySchema);

    const admin = createPaymentsAdminService(prisma, authorization);
    const dashboard = createDashboardService(prisma, authorization);

    const rows =
      query.ids !== undefined
        ? await admin.selectedRows(
            session,
            query.ids
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value !== ""),
          )
        : await exportFiltered(admin, dashboard, session, request);

    const filename = `${paymentsFileBase()}.${query.format}`;
    // Exports carry names, references and review notes: keep them out of caches.
    const headers: HeadersInit = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    };

    if (query.format === "csv") {
      const bytes = new TextEncoder().encode(
        sheetCsv({ headers: PAYMENTS_HEADERS, rows: paymentsMatrix(rows) }),
      );
      return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": CSV_MIME } });
    }

    const buffer = await writeXlsxFile(
      [
        PAYMENTS_HEADERS.map((header) => ({ value: header, fontWeight: "bold" as const })),
        ...paymentsMatrix(rows),
      ],
      {
        sheet: "Pagos",
        orientation: "landscape",
        columns: PAYMENTS_COLUMN_WIDTHS.map((width) => ({ width })),
      },
    ).toBuffer();

    // A fresh Uint8Array<ArrayBuffer>: a Node Buffer's ArrayBufferLike backing
    // does not satisfy BodyInit under TS 5.7.
    const bytes = new Uint8Array(buffer);
    return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": XLSX_MIME } });
  });
}

async function exportFiltered(
  admin: ReturnType<typeof createPaymentsAdminService>,
  dashboard: ReturnType<typeof createDashboardService>,
  session: Awaited<ReturnType<typeof requireApiSession>>,
  request: Request,
) {
  const customFields = await dashboard.listDashboardCustomFields(session);
  const filters = parsePaymentsFilters(new URL(request.url).searchParams, {
    customFieldCodes: customFields.map((field) => field.code),
  });
  return admin.exportRows(session, filters);
}
