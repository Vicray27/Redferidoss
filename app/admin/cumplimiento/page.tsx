import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization, type SessionActor } from "@/lib/authz";
import { heatColor } from "@/lib/charts";
import {
  COMPLIANCE_STATE_LABELS,
  COMPLIANCE_WINDOWS,
  createDashboardService,
  DEFAULT_COMPLIANCE_WINDOW,
  resolveWindow,
  type ComplianceMatrix,
  type ComplianceOptions,
  type ComplianceState,
  type DashboardService,
} from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { createReportsService, weekRangeLabel, type CycleOption } from "@/lib/reports";
import { cn } from "@/lib/utils";

// =============================================================================
// app/admin/cumplimiento/page.tsx — §8.5: the person × week compliance matrix.
//
// Four states, four colors (D54): approved/pending/missed/exempt — the gray is
// a real answer ("without obligation" and "exempt" are not failures), which is
// why the legend is part of the page and not decoration. Every non-exempt cell
// drills down into the FILTERED master table (`/admin/pagos?userId=…&cycles=…`):
// the detail view is not a second screen, it is the table everyone already
// knows, with two filters applied.
//
// Filters and paging live in the URL: person, level, week window and page are
// shareable. The window COLUMNS never depend on the page's people — the service
// reads them from the window cycles so every column always renders.
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

const STATE_COLORS: Record<ComplianceState, string> = {
  approved: heatColor(1),
  pending: heatColor(0.5),
  missed: heatColor(0),
  exempt: heatColor(null),
};

export default async function CompliancePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/cumplimiento");
  const params = await searchParams;
  const requestedKey = textParam(params.cycle) || undefined;
  // `weeks` is the canonical param; `semanas` keeps older links working.
  const weeks = resolveWindow(
    textParam(params.weeks) || textParam(params.semanas) || undefined,
    COMPLIANCE_WINDOWS,
    DEFAULT_COMPLIANCE_WINDOW,
  );
  const q = textParam(params.q).trim().slice(0, 120);
  const level = parseLevel(params.level);
  const page = positiveInt(params.page);
  const pageSize = parsePageSize(params.page_size);

  const dashboard = createDashboardService(prisma, authorization);
  const reports = createReportsService(prisma, authorization);
  const [cycles, levels, resolved] = await Promise.all([
    reports.listCycles(session),
    dashboard.complianceLevels(session),
    loadMatrix(dashboard, session, {
      periodKey: requestedKey,
      weeks,
      q,
      level: level ?? undefined,
      page,
      pageSize,
    }),
  ]);
  const { matrix, notice } = resolved;

  return (
    <SessionShell
      session={session}
      title="Cumplimiento"
      description="La matriz persona × semana: quién aprobó, quién debe y quién no tenía obligación. Solo personal autorizado."
    >
      {matrix === null ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          {notice ?? "Todavía no hay semanas registradas."}
        </p>
      ) : (
        <MatrixView
          matrix={matrix}
          cycles={cycles}
          levels={levels}
          notice={notice}
          q={q}
          level={level}
          requestedKey={requestedKey}
          weeksParam={textParam(params.weeks) || textParam(params.semanas)}
        />
      )}
    </SessionShell>
  );
}

function MatrixView({
  matrix,
  cycles,
  levels,
  notice,
  q,
  level,
  requestedKey,
  weeksParam,
}: {
  matrix: ComplianceMatrix;
  cycles: CycleOption[];
  levels: number[];
  notice: string | null;
  q: string;
  level: number | null;
  requestedKey: string | undefined;
  weeksParam: string;
}) {
  const { cycle } = matrix;
  const options = cycles.some((option) => option.periodKey === cycle.periodKey)
    ? cycles
    : [cycle, ...cycles];
  const totalPages = Math.max(1, Math.ceil(matrix.total / matrix.pageSize));
  const firstRow = matrix.total === 0 ? 0 : (matrix.page - 1) * matrix.pageSize + 1;
  const lastRow = Math.min(matrix.page * matrix.pageSize, matrix.total);
  const filtersActive =
    q !== "" ||
    level !== null ||
    requestedKey !== undefined ||
    weeksParam !== "" ||
    matrix.pageSize !== DEFAULT_PAGE_SIZE;
  const query = filterQuery({
    cycle: cycle.periodKey,
    weeks: matrix.weeks,
    q,
    level,
    pageSize: matrix.pageSize,
  });

  return (
    <div className="space-y-6">
      {notice ? (
        <p className="rounded-md border border-dashed bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {matrix.total === 0
          ? "Sin resultados con los filtros actuales."
          : `${matrix.total.toLocaleString("es")} personas · mostrando ${firstRow}–${lastRow}`}
      </p>

      <form method="get" className="grid gap-4 rounded-lg border bg-background p-4 lg:grid-cols-5">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Semana</span>
          <select
            name="cycle"
            defaultValue={cycle.periodKey}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {options.map((option) => (
              <option key={option.id} value={option.periodKey}>
                {weekRangeLabel(option.startsAt, option.endsAt)}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Periodo</span>
          <select
            name="weeks"
            defaultValue={String(matrix.weeks)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="4">4 semanas</option>
            <option value="12">12 semanas</option>
            <option value="26">26 semanas</option>
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Persona</span>
          <input
            type="text"
            name="q"
            maxLength={120}
            placeholder="Nombre, correo o código…"
            defaultValue={q}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Nivel</span>
          <select
            name="level"
            defaultValue={level === null ? "" : String(level)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Todos</option>
            {levels.map((value) => (
              <option key={value} value={value}>
                Nivel {value}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Filas por página
          </span>
          <select
            name="page_size"
            defaultValue={String(matrix.pageSize)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end gap-2 lg:col-span-5">
          <Button type="submit" variant="outline">
            Aplicar filtros
          </Button>
          {filtersActive ? (
            <Link
              href="/admin/cumplimiento"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Limpiar filtros
            </Link>
          ) : null}
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {(Object.keys(COMPLIANCE_STATE_LABELS) as ComplianceState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-black/5"
              style={{ backgroundColor: STATE_COLORS[state] }}
              aria-hidden
            />
            {COMPLIANCE_STATE_LABELS[state]}
          </span>
        ))}
        <span>· Haz clic en una celda para ver el detalle en Pagos.</span>
      </div>

      {matrix.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          No hay personas con obligaciones o reportes en la ventana.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 bg-background px-3 py-3 font-medium">Persona</th>
                <th className="px-3 py-3 font-medium">Nivel</th>
                {matrix.periodKeys.map((periodKey) => (
                  <th key={periodKey} className="px-2 py-3 text-center font-medium">
                    {periodKey}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.userId} className="border-b last:border-0">
                  <td className="sticky left-0 bg-background px-3 py-2">
                    <span className="block max-w-64 truncate font-medium">{row.fullName}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {row.publicCode}
                    </span>
                  </td>
                  <td className="px-3 py-2">{row.level}</td>
                  {row.cells.map((cell) => {
                    const label = `${row.fullName} · ${cell.periodKey}: ${COMPLIANCE_STATE_LABELS[cell.state]}`;
                    const swatch = (
                      <span
                        className="inline-block h-4 w-4 rounded-sm border border-black/5"
                        style={{ backgroundColor: STATE_COLORS[cell.state] }}
                        title={label}
                        aria-label={label}
                        role="img"
                      />
                    );

                    return (
                      <td key={cell.periodKey} className="px-2 py-2 text-center">
                        {cell.state === "exempt" ? (
                          swatch
                        ) : (
                          <Link
                            href={`/admin/pagos?userId=${row.userId}&cycles=${encodeURIComponent(cell.periodKey)}`}
                            className="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {swatch}
                          </Link>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <nav className="flex items-center justify-end gap-3 text-sm" aria-label="Paginación">
          {matrix.page > 1 ? (
            <Link
              href={`/admin/cumplimiento?${pageQuery(query, matrix.page - 1)}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Anterior
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            Página {matrix.page} de {totalPages}
          </span>
          {matrix.page < totalPages ? (
            <Link
              href={`/admin/cumplimiento?${pageQuery(query, matrix.page + 1)}`}
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

/** The matrix, with the same graceful fallback as the rest of /admin. */
async function loadMatrix(
  dashboard: DashboardService,
  actor: SessionActor,
  options: ComplianceOptions,
): Promise<{ matrix: ComplianceMatrix | null; notice: string | null }> {
  try {
    return {
      matrix: await dashboard.getCompliance(actor, options),
      notice: null,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (options.periodKey !== undefined) {
      try {
        return {
          matrix: await dashboard.getCompliance(actor, { ...options, periodKey: undefined }),
          notice: `La semana ${options.periodKey} no existe; se muestra la semana vigente.`,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof NotFoundError)) throw fallbackError;
      }
    }
    return { matrix: null, notice: null };
  }
}

/** First value of a search param; arrays and missing keys degrade to "". */
function textParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Page number from the URL: integers >= 1, otherwise page 1. */
function positiveInt(value: string | string[] | undefined): number {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/** Level integer >= 0, otherwise no filter. */
function parseLevel(value: string | string[] | undefined): number | null {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** The three supported page sizes; anything else falls back to 50. */
function parsePageSize(value: string | string[] | undefined): (typeof PAGE_SIZES)[number] {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return (PAGE_SIZES as readonly number[]).includes(raw)
    ? (raw as (typeof PAGE_SIZES)[number])
    : DEFAULT_PAGE_SIZE;
}

/** Normalized filters for the pagination links — no `page`, no unknown values. */
function filterQuery(filters: {
  cycle: string;
  weeks: number;
  q: string;
  level: number | null;
  pageSize: number;
}): URLSearchParams {
  const query = new URLSearchParams();
  query.set("cycle", filters.cycle);
  if (filters.weeks !== DEFAULT_COMPLIANCE_WINDOW) query.set("weeks", String(filters.weeks));
  if (filters.q !== "") query.set("q", filters.q);
  if (filters.level !== null) query.set("level", String(filters.level));
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) query.set("page_size", String(filters.pageSize));
  return query;
}

function pageQuery(query: URLSearchParams, page: number): string {
  const next = new URLSearchParams(query);
  next.set("page", String(page));
  return next.toString();
}
