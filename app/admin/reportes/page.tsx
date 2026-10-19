import Link from "next/link";

import { DonutChart } from "@/components/charts/donut-chart";
import { SessionShell } from "@/components/session-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization, type SessionActor } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import {
  CONSOLIDATED_PAGE_SIZE_DEFAULT,
  CONSOLIDATED_PAGE_SIZES,
  createReportsService,
  sharedCurrencyLabel,
  sheetMatrix,
  weekRangeLabel,
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
  const page = positiveInt(params.page);
  const pageSize = parsePageSize(params.page_size);

  const reports = createReportsService(prisma, authorization);
  const [cycles, resolved] = await Promise.all([
    reports.listCycles(session),
    loadSheet(reports, session, requestedKey, page, pageSize),
  ]);
  const { sheet, notice } = resolved;

  return (
    <SessionShell
      session={session}
      title="Reportes"
      description="Planilla consolidada de la semana: quién reportó, qué pasó y qué se ofrendó. Solo personal autorizado."
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
  // Paginated reads carry the week-wide label from the totals query; the
  // row-derived label remains for any non-paginated caller.
  const currency =
    sheet.currencyLabel !== undefined ? sheet.currencyLabel : sharedCurrencyLabel(sheet);
  const total = sheet.total ?? sheet.rows.length;
  const pageNumber = sheet.page ?? 1;
  const pageSize = sheet.pageSize ?? CONSOLIDATED_PAGE_SIZE_DEFAULT;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (pageNumber - 1) * pageSize + 1;
  const lastRow = Math.min(pageNumber * pageSize, total);
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
                  {weekRangeLabel(option.startsAt, option.endsAt)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline">
            Aplicar filtros
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

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Participación de la semana</h2>
        <DonutChart
          slices={[
            { name: "Reportaron", value: totals.reported, valueLabel: String(totals.reported) },
            {
              name: "No reportaron",
              value: totals.notReported,
              valueLabel: String(totals.notReported),
            },
          ]}
          ariaLabel={`Participación de la semana ${cycle.periodKey}: ${totals.reported} reportaron y ${totals.notReported} no reportaron`}
          emptyText="No hay personas en la semana para graficar."
        />
      </section>

      <p className="text-sm text-muted-foreground">
        {total === 0
          ? "Sin resultados en esta semana."
          : `${total.toLocaleString("es")} personas · mostrando ${firstRow}–${lastRow}`}
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

      {totalPages > 1 ? (
        <nav className="flex items-center justify-end gap-3 text-sm" aria-label="Paginación">
          {pageNumber > 1 ? (
            <Link
              href={`/admin/reportes?${pageLink(cycle.periodKey, pageSize, pageNumber - 1)}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Anterior
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            Página {pageNumber} de {totalPages}
          </span>
          {pageNumber < totalPages ? (
            <Link
              href={`/admin/reportes?${pageLink(cycle.periodKey, pageSize, pageNumber + 1)}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Siguiente
            </Link>
          ) : null}
        </nav>
      ) : null}
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
  page: number,
  pageSize: number,
): Promise<{ sheet: ConsolidatedSheet | null; notice: string | null }> {
  const pagination = { page, pageSize };
  try {
    return {
      sheet: await reports.getConsolidatedSheet(actor, { ...pagination, periodKey: requestedKey }),
      notice: null,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (requestedKey !== undefined) {
      // The week in the URL does not exist: fall back to the current one
      // instead of trading the whole page for an error screen.
      try {
        return {
          sheet: await reports.getConsolidatedSheet(actor, pagination),
          notice: `La semana ${requestedKey} no existe; se muestra la semana vigente.`,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof NotFoundError)) throw fallbackError;
      }
    }
    return { sheet: null, notice: null };
  }
}

/** Page number from the URL: integers >= 1, otherwise page 1. */
function positiveInt(value: string | string[] | undefined): number {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/** The three supported page sizes; anything else falls back to 50. */
function parsePageSize(value: string | string[] | undefined): number {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return (CONSOLIDATED_PAGE_SIZES as readonly number[]).includes(raw)
    ? raw
    : CONSOLIDATED_PAGE_SIZE_DEFAULT;
}

/** Pagination link: ONLY the cycle plus page and page_size survive. */
function pageLink(periodKey: string, pageSize: number, page: number): string {
  const query = new URLSearchParams();
  query.set("cycle", periodKey);
  if (pageSize !== CONSOLIDATED_PAGE_SIZE_DEFAULT) query.set("page_size", String(pageSize));
  query.set("page", String(page));
  return query.toString();
}
