import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { Button } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization, type SessionActor } from "@/lib/authz";
import { heatColor } from "@/lib/charts";
import {
  COMPLIANCE_MAX_USERS,
  COMPLIANCE_STATE_LABELS,
  COMPLIANCE_WINDOWS,
  createDashboardService,
  DEFAULT_COMPLIANCE_WINDOW,
  resolveWindow,
  type ComplianceMatrix,
  type ComplianceState,
  type DashboardService,
} from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { createReportsService, dateLabel, type CycleOption } from "@/lib/reports";

// =============================================================================
// app/admin/cumplimiento/page.tsx — §8.5: the person × week compliance matrix.
//
// Four states, four colors (D54): approved/pending/missed/exempt — the gray is
// a real answer ("without obligation" and "exempt" are not failures), which is
// why the legend is part of the page and not decoration. Every non-exempt cell
// drills down into the FILTERED master table (`/admin/pagos?userId=…&cycles=…`):
// the detail view is not a second screen, it is the table everyone already
// knows, with two filters applied.
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STATE_COLORS: Record<ComplianceState, string> = {
  approved: heatColor(1),
  pending: heatColor(0.5),
  missed: heatColor(0),
  exempt: heatColor(null),
};

export default async function CompliancePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/cumplimiento");
  const params = await searchParams;
  const requestedKey = typeof params.cycle === "string" ? params.cycle : undefined;
  const weeks = resolveWindow(
    typeof params.semanas === "string" ? params.semanas : undefined,
    COMPLIANCE_WINDOWS,
    DEFAULT_COMPLIANCE_WINDOW,
  );

  const dashboard = createDashboardService(prisma, authorization);
  const reports = createReportsService(prisma, authorization);
  const [cycles, resolved] = await Promise.all([
    reports.listCycles(),
    loadMatrix(dashboard, session, requestedKey, weeks),
  ]);
  const { matrix, notice } = resolved;

  return (
    <SessionShell
      session={session}
      title="Cumplimiento"
      description="La matriz persona × semana: quién aprobó, quién debe y quién no tenía obligación. Solo staff."
    >
      {matrix === null ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          {notice ?? "Todavía no hay semanas registradas."}
        </p>
      ) : (
        <MatrixView matrix={matrix} cycles={cycles} notice={notice} weeks={weeks} />
      )}
    </SessionShell>
  );
}

function MatrixView({
  matrix,
  cycles,
  notice,
  weeks,
}: {
  matrix: ComplianceMatrix;
  cycles: CycleOption[];
  notice: string | null;
  weeks: number;
}) {
  const { cycle } = matrix;
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

      <form method="get" className="flex flex-wrap items-end gap-3">
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
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Ventana</span>
          <select
            name="semanas"
            defaultValue={String(weeks)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="4">4 semanas</option>
            <option value="12">12 semanas</option>
            <option value="26">26 semanas</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Ver
        </Button>
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
        <span>· Cada celda enlaza a la tabla maestra filtrada por esa persona y semana.</span>
      </div>

      {matrix.truncated ? (
        <p
          role="status"
          className="rounded-md border border-dashed bg-muted/40 px-4 py-2 text-sm text-muted-foreground"
        >
          La red supera las {COMPLIANCE_MAX_USERS} personas: se muestran las primeras{" "}
          {COMPLIANCE_MAX_USERS}. Usa los filtros de la tabla maestra para auditar al resto.
        </p>
      ) : null}

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
    </div>
  );
}

/** The matrix, with the same graceful fallback as the rest of /admin. */
async function loadMatrix(
  dashboard: DashboardService,
  actor: SessionActor,
  requestedKey: string | undefined,
  weeks: number,
): Promise<{ matrix: ComplianceMatrix | null; notice: string | null }> {
  try {
    return {
      matrix: await dashboard.getCompliance(actor, { periodKey: requestedKey, weeks }),
      notice: null,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (requestedKey !== undefined) {
      try {
        return {
          matrix: await dashboard.getCompliance(actor, { weeks }),
          notice: `La semana ${requestedKey} no existe; se muestra la semana vigente.`,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof NotFoundError)) throw fallbackError;
      }
    }
    return { matrix: null, notice: null };
  }
}
