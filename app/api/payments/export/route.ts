// =============================================================================
// app/api/payments/export/route.ts — §8.5: download the master payments table.
//
// Two doors, one matrix: the full filtered set (`exportRows`, hard capped at
// PAYMENTS_EXPORT_MAX_ROWS) or the checkbox selection (`selectedRows`,
// addressed by id). Both render `paymentsMatrix` — the same fixed 16 columns
// plus one per dashboard-visible custom field (D57) that the screen shows — so
// the file and the table cannot disagree (D51).
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
import { buildPresentationSheet, EXPORT_BRAND, exportStampLabel } from "@/lib/export-presentation";
import { addAmounts, formatAmount, parseAmount } from "@/lib/money";
import {
  createPaymentsAdminService,
  parsePaymentsFilters,
  paymentsFileBase,
  paymentsHeaders,
  paymentsMatrix,
  type PaymentsExportField,
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
const CUSTOM_COLUMN_WIDTH = 18;

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const query = parseQuery(request, querySchema);

    const admin = createPaymentsAdminService(prisma, authorization);
    const dashboard = createDashboardService(prisma, authorization);

    // The dashboard fields define the extra columns of BOTH doors (D57), so
    // both files carry the same header as the table. Read once per request.
    const readFields = async (): Promise<PaymentsExportField[]> =>
      (await dashboard.listDashboardCustomFields(session)).map((field) => ({
        code: field.code,
        label: field.label,
      }));

    let rows;
    let fields: PaymentsExportField[];
    const isSelection = query.ids !== undefined;
    if (query.ids !== undefined) {
      // The selection door validates the ids FIRST (a selection that parses to
      // nothing is a 400 before any statement — D51); only then are the column
      // definitions read, because the export still needs its header.
      rows = await admin.selectedRows(
        session,
        query.ids
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      );
      fields = await readFields();
    } else {
      fields = await readFields();
      rows = await exportFiltered(admin, session, request, fields);
    }

    const filename = `${paymentsFileBase()}.${query.format}`;
    // Exports carry names, references and review notes: keep them out of caches.
    const headers: HeadersInit = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    };

    const sheetHeaders = paymentsHeaders(fields);
    const sheetRows = paymentsMatrix(rows, fields);

    if (query.format === "csv") {
      const bytes = new TextEncoder().encode(
        sheetCsv({ headers: sheetHeaders, rows: sheetRows }),
      );
      return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": CSV_MIME } });
    }

    const rowCount = rows.length;
    // "Suma de las filas", never "total aprobado": the exported set may include
    // pending and rejected reports, so the label must not imply otherwise.
    const currencies = new Set(rows.map((row) => row.currency));
    let summary = `Filas: ${rowCount}`;
    if (rowCount > 0 && currencies.size === 1) {
      const total = formatAmount(addAmounts(...rows.map((row) => parseAmount(row.amount))));
      summary += ` · Suma de las filas: ${total} ${rows[0].currency}`;
    }

    const presentation = buildPresentationSheet({
      title: `${EXPORT_BRAND.name} — Pagos`,
      subtitle:
        `${isSelection ? "Selección manual" : "Filtros aplicados"} (${rowCount} filas)` +
        ` · Generado el ${exportStampLabel(new Date())}`,
      summary,
      headers: sheetHeaders,
      rows: sheetRows,
      widths: [...PAYMENTS_COLUMN_WIDTHS, ...fields.map(() => CUSTOM_COLUMN_WIDTH)],
      numericColumns: [5, 7],
      footer:
        'Los montos son valores DECIMAL(14,2). Una celda "-" significa que el dato no está disponible.',
    });

    const buffer = await writeXlsxFile(presentation.data, {
      sheet: "Pagos",
      orientation: "landscape",
      showGridLines: false,
      stickyRowsCount: presentation.stickyRowsCount,
      columns: presentation.columns,
    }).toBuffer();

    // A fresh Uint8Array<ArrayBuffer>: a Node Buffer's ArrayBufferLike backing
    // does not satisfy BodyInit under TS 5.7.
    const bytes = new Uint8Array(buffer);
    return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": XLSX_MIME } });
  });
}

async function exportFiltered(
  admin: ReturnType<typeof createPaymentsAdminService>,
  session: Awaited<ReturnType<typeof requireApiSession>>,
  request: Request,
  fields: readonly PaymentsExportField[],
) {
  const filters = parsePaymentsFilters(new URL(request.url).searchParams, {
    customFieldCodes: fields.map((field) => field.code),
  });
  return admin.exportRows(session, filters);
}
