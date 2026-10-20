import Link from "next/link";

import { requireStaffSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { exportStampLabel } from "@/lib/export-presentation";
import {
  createReportsService,
  dateLabel,
  sharedCurrencyLabel,
  sheetMatrix,
  type ConsolidatedSheet,
} from "@/lib/reports";

import { PrintButton } from "./print-button";

// =============================================================================
// app/admin/reportes/imprimir/page.tsx — the paper face of the sheet (§8.4).
//
// Deliberately NOT inside SessionShell: the shell is navigation chrome, and
// navigation chrome must not reach the printer. Everything on this page is the
// document — header, summary, table, footer line — and the only interactive
// control hides itself via `print:hidden`. "Export to PDF" is the browser's own
// print dialog (D48): zero extra dependencies, and the printed page is exactly
// the matrix the screen and the XLSX carry.
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_STYLE = `
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@page { size: A4 landscape; margin: 12mm; }
@media print {
  body { background: white !important; }
  table { border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
}
`;

export default async function PrintReportPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/reportes/imprimir");
  const params = await searchParams;
  const requestedKey = typeof params.cycle === "string" ? params.cycle : undefined;

  const reports = createReportsService(prisma, authorization);
  let sheet: ConsolidatedSheet;
  try {
    sheet = await reports.getConsolidatedSheet(session, { periodKey: requestedKey });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // No requested week and no planned cycles: nothing to print, and a paper
    // face has no business showing a fallback — say it plainly.
    if (requestedKey === undefined) {
      return (
        <main className="p-8 text-sm text-muted-foreground">
          <style>{PAGE_STYLE}</style>
          Todavía no hay semanas registradas: no hay nada que imprimir.
        </main>
      );
    }
    sheet = await reports.getConsolidatedSheet(session);
  }

  const matrix = sheetMatrix(sheet);
  const { cycle, totals } = sheet;
  const currency = sharedCurrencyLabel(sheet);
  const money = (amount: string) => (currency ? `${amount} ${currency}` : amount);
  const stats: Array<{ label: string; value: string | number }> = [
    { label: "Personas", value: totals.people },
    { label: "Reportaron", value: totals.reported },
    { label: "No reportaron", value: totals.notReported },
    { label: "Asistieron", value: totals.attended },
    { label: "Ofrendaron", value: totals.offered },
    { label: "Total reportado", value: money(totals.amountTotal) },
    { label: "Aprobado", value: money(totals.amountApproved) },
    { label: "Visitantes", value: totals.visitors },
  ];

  return (
    <main className="min-h-screen bg-white px-8 py-6 text-foreground print:px-0 print:py-0">
      <style>{PAGE_STYLE}</style>

      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/admin/reportes?cycle=${cycle.periodKey}`} className="text-sm underline">
          ← Volver a la planilla
        </Link>
        <PrintButton />
      </div>

      <header className="mb-5">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#2e67ff]">
          RED DE REFERIDOS
        </p>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-[#0e142b]">
          Planilla consolidada — {cycle.periodKey}
        </h1>
        <p className="mt-1 text-sm text-[#0e142b]/70">
          Del {dateLabel(cycle.startsAt)} al {dateLabel(cycle.endsAt)} · Generada el{" "}
          {exportStampLabel(new Date())}
        </p>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-md border border-[#e7e4e4] bg-[#fcfcfc] px-2.5 py-1.5"
          >
            <p className="text-[9px] font-medium uppercase tracking-wide text-[#0e142b]/60">
              {stat.label}
            </p>
            <p className="text-sm font-semibold text-[#0e142b]">{stat.value}</p>
          </div>
        ))}
      </section>

      <table className="w-full border-collapse border border-[#e7e4e4] text-left text-[10px] leading-tight">
        <thead>
          <tr>
            {matrix.headers.map((header) => (
              <th
                key={header}
                className={`border border-[#e7e4e4] bg-[#2e67ff] px-1.5 py-1 font-semibold text-white ${
                  header === "Monto" ? "text-right" : ""
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((cells, rowIndex) => (
            <tr
              key={sheet.rows[rowIndex]?.userId ?? rowIndex}
              className={rowIndex % 2 === 1 ? "bg-[#f7f8fb]" : "bg-white"}
            >
              {cells.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={`border border-[#e7e4e4] px-1.5 py-1 text-[#0e142b] ${
                    matrix.headers[cellIndex] === "Monto" ? "text-right" : ""
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {matrix.rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No hay personas con obligación, reporte semanal ni ofrenda en esta semana.
        </p>
      ) : null}

      <footer className="mt-4 text-[10px] text-muted-foreground">
        Los montos no incluyen los aportes rechazados. Los totales son la suma exacta de las filas listadas.
      </footer>
    </main>
  );
}
