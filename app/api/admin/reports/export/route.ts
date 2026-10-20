// =============================================================================
// app/api/admin/reports/export/route.ts — §8.4: download the consolidated sheet.
//
// Two formats, one source of truth: both render `sheetMatrix(sheet)` — the very
// matrix the admin page draws — so the file a coordinator downloads and the
// table they saw on screen cannot disagree. `format=csv` writes RFC 4180 with a
// UTF-8 BOM (Excel needs it for accents); `format=xlsx` goes through
// write-excel-file (D47) with the header bold and the shared column widths.
//
// This is a download, not an API resource: the body is the file itself, not the
// §10 envelope — except on failure, where `withApi` still answers with the
// envelope (401/403/404/400 as JSON).
// =============================================================================

import { z } from "zod";
import writeXlsxFile from "write-excel-file/node";

import { parseQuery, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { buildPresentationSheet, EXPORT_BRAND, exportStampLabel } from "@/lib/export-presentation";
import {
  createReportsService,
  dateLabel,
  sharedCurrencyLabel,
  sheetCsv,
  sheetFileName,
  sheetMatrix,
  SHEET_COLUMN_WIDTHS,
} from "@/lib/reports";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv; charset=utf-8";

const querySchema = z.object({
  // `period_key` vocabulary only; the week is resolved against the database,
  // never concatenated into SQL.
  cycle: z.string().regex(/^[A-Za-z0-9-]{1,20}$/, "La semana no es válida").optional(),
  format: z.enum(["xlsx", "csv"]).default("xlsx"),
});

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const query = parseQuery(request, querySchema);

    const reports = createReportsService(prisma, authorization);
    const sheet = await reports.getConsolidatedSheet(session, { periodKey: query.cycle });
    const matrix = sheetMatrix(sheet);
    const filename = sheetFileName(sheet.cycle.periodKey, query.format);
    // Exports carry names and amounts: never let a proxy or browser keep them.
    const headers: HeadersInit = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    };

    if (query.format === "csv") {
      const bytes = new TextEncoder().encode(sheetCsv(matrix));
      return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": CSV_MIME } });
    }

    const { totals } = sheet;
    const currency = sharedCurrencyLabel(sheet);
    const money = (amount: string) => (currency ? `${amount} ${currency}` : amount);
    const presentation = buildPresentationSheet({
      title: `${EXPORT_BRAND.name} — Planilla consolidada`,
      subtitle:
        `Semana ${sheet.cycle.periodKey} · Del ${dateLabel(sheet.cycle.startsAt)}` +
        ` al ${dateLabel(sheet.cycle.endsAt)} · Generada el ${exportStampLabel(new Date())}`,
      summary:
        `Personas: ${totals.people} · Reportaron: ${totals.reported}` +
        ` · No reportaron: ${totals.notReported} · Asistieron: ${totals.attended}` +
        ` · Ofrendaron: ${totals.offered} · Total reportado: ${money(totals.amountTotal)}` +
        ` · Aprobado: ${money(totals.amountApproved)} · Visitantes: ${totals.visitors}`,
      headers: matrix.headers,
      rows: matrix.rows,
      widths: SHEET_COLUMN_WIDTHS,
      numericColumns: [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18],
      footer:
        "Los montos no incluyen los aportes rechazados. Los totales son la suma exacta de las filas listadas.",
    });

    const buffer = await writeXlsxFile(presentation.data, {
      sheet: "Planilla",
      orientation: "landscape",
      showGridLines: false,
      stickyRowsCount: presentation.stickyRowsCount,
      columns: presentation.columns,
    }).toBuffer();

    // A fresh Uint8Array<ArrayBuffer>: a Node Buffer is a Uint8Array too, but
    // its ArrayBufferLike backing does not satisfy BodyInit under TS 5.7.
    const bytes = new Uint8Array(buffer);
    return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": XLSX_MIME } });
  });
}
