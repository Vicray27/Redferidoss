import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization, type SessionActor } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import {
  createReportsService,
  dateLabel,
  sharedCurrencyLabel,
  sheetMatrix,
  type ConsolidatedSheet,
  type CycleOption,
  type ReportsService,
} from "@/lib/reports";
import { cn } from "@/lib/utils";

// =============================================================================
// app/admin/reportes/page.tsx — §8.4's consolidated sheet, §8.5's audience.
//
// The page is a thin face over `createReportsService`: pick a week, read the
// matrix, render it. Every export link (print, xlsx, csv) points at the same
// service so the document a coordinator downloads is the table they saw.
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/reportes");
  const params = await searchParams;
  const requestedKey = typeof params.cycle === "string" ? params.cycle : undefined;

  const reports = createReportsService(prisma, authorization);
  const [cycles, resolved] = await Promise.all([
    reports.listCycles(),
    loadSheet(reports, session, requestedKey),
  ]);
  const { sheet, notice } = resolved;

  return (
    <SessionShell
      session={session}
      title="Reportes"
      description="Planilla consolidada de la semana: quién reportó, qué pasó y qué se ofrendó. Solo staff."
    >
      {sheet === null ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          {notice ?? "Todavía no hay semanas registradas."}
        </p>
      ) : (
        <SheetView sheet={sheet} cycles={cycles} notice={notice} />
      )}
    </SessionShell>
  );
}

function SheetView({
  sheet,
  cycles,
  notice,
}: {
  sheet: ConsolidatedSheet;
  cycles: CycleOption[];
  notice: string | null;
}) {
  const matrix = sheetMatrix(sheet);
  const { totals, cycle } = sheet;
  const currency = sharedCurrencyLabel(sheet);
  const options = cycles.some((option) => option.periodKey === cycle.periodKey)
    ? cycles
    : [cycle, ...cycles];

  return (
    <div className="space-y-6">
      {notice ? (
        <p className="rounded-md border border-dashed bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <form method="get" className="flex items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Semana</span>
            <select
              name="cycle"
              defaultValue={cycle.periodKey}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {options.map((option) => (
                <option key={option.id} value={option.periodKey}>
                  {option.periodKey} · {dateLabel(option.startsAt)} – {dateLabel(option.endsAt)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline">
            Ver
          </Button>
        </form>

        <div className="ml-auto flex flex-wrap gap-2 print:hidden">
          <Link
            href={`/admin/reportes/imprimir?cycle=${cycle.periodKey}`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Imprimir / PDF
          </Link>
          <Link
            href={`/api/admin/reports/export?cycle=${cycle.periodKey}&format=xlsx`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Excel (.xlsx)
          </Link>
          <Link
            href={`/api/admin/reports/export?cycle=${cycle.periodKey}&format=csv`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            CSV
          </Link>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Personas" value={String(totals.people)} />
        <Stat label="Reportaron" value={String(totals.reported)} />
        <Stat label="No reportaron" value={String(totals.notReported)} />
        <Stat label="Asistieron" value={String(totals.attended)} />
        <Stat label="Ofrendaron" value={String(totals.offered)} />
        <Stat
          label="Total reportado"
          value={currency ? `${totals.amountTotal} ${currency}` : totals.amountTotal}
        />
        <Stat
          label="Aprobado"
          value={currency ? `${totals.amountApproved} ${currency}` : totals.amountApproved}
        />
        <Stat label="Visitantes" value={String(totals.visitors)} />
      </dl>

      <p className="text-xs text-muted-foreground">
        Los montos no incluyen los aportes rechazados. «Sin actividad» es quien reportó con todo en
        cero; «No reportó» es quien no envió nada.
      </p>

      {matrix.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          No hay personas con obligación, reporte semanal ni ofrenda en esta semana.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                {matrix.headers.map((header) => (
                  <th key={header} className="whitespace-nowrap px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {matrix.rows.map((cells, rowIndex) => (
                <tr key={sheet.rows[rowIndex]?.userId ?? rowIndex} className="hover:bg-muted/30">
                  {cells.map((cell, cellIndex) => (
                    <td key={cellIndex} className="whitespace-nowrap px-3 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}

/** The effective sheet, with a graceful fallback when the asked week is gone. */
async function loadSheet(
  reports: ReportsService,
  actor: SessionActor,
  requestedKey: string | undefined,
): Promise<{ sheet: ConsolidatedSheet | null; notice: string | null }> {
  try {
    return { sheet: await reports.getConsolidatedSheet(actor, { periodKey: requestedKey }), notice: null };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (requestedKey !== undefined) {
      // The week in the URL does not exist: fall back to the current one
      // instead of trading the whole page for an error screen.
      try {
        return {
          sheet: await reports.getConsolidatedSheet(actor),
          notice: `La semana ${requestedKey} no existe; se muestra la semana vigente.`,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof NotFoundError)) throw fallbackError;
      }
    }
    return { sheet: null, notice: null };
  }
}
