import Link from "next/link";

import { BarChart } from "@/components/charts/bar-chart";
import { ComplianceHeatmap, shortPeriodKey } from "@/components/charts/compliance-heatmap";
import { HorizontalBarChart } from "@/components/charts/horizontal-bar-chart";
import { LineChart } from "@/components/charts/line-chart";
import { SessionShell } from "@/components/session-shell";
import { Button } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization, type SessionActor } from "@/lib/authz";
import { resolveChartWindow } from "@/lib/charts";
import { createDashboardService, type DashboardOverview, type DashboardService } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { formatAmount, parseAmount } from "@/lib/money";
import { createReportsService, dateLabel, type CycleOption } from "@/lib/reports";
import { settings } from "@/lib/settings";

// =============================================================================
// app/admin/page.tsx — §8.5: the dashboard of "la Persona #1" (F5).
//
// The root sees the whole network's money here: seven KPI cards, five charts
// and the door to the master table and the compliance matrix. The page is a
// thin face over `createDashboardService`, exactly like /admin/reportes: pick
// a week (and a window), read, render. The charts are ECharts client
// components (D75): the server pre-formats every money label with
// formatAmount and only serializable strings/numbers reach the browser, so no
// amount is ever formatted client-side. The compliance heatmap stays a
// server-rendered grid (D49).
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin");
  const params = await searchParams;
  const requestedKey = typeof params.cycle === "string" ? params.cycle : undefined;
  const weeks = resolveChartWindow(typeof params.semanas === "string" ? params.semanas : undefined);

  const dashboard = createDashboardService(prisma, authorization);
  const reports = createReportsService(prisma, authorization);
  const [cycles, currency, resolved] = await Promise.all([
    reports.listCycles(session),
    settings.getOrThrow<string>("payments.currency"),
    loadOverview(dashboard, session, requestedKey, weeks),
  ]);
  const { overview, notice } = resolved;

  return (
    <SessionShell
      session={session}
      title="Panel de administración"
      description="Todos los aportes de la red: métricas de la semana, gráficas y accesos a la tabla maestra y al cumplimiento. Solo staff."
    >
      {overview === null ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          {notice ?? "Todavía no hay semanas registradas."}
        </p>
      ) : (
        <Overview
          overview={overview}
          cycles={cycles}
          currency={currency}
          notice={notice}
          weeks={weeks}
        />
      )}
    </SessionShell>
  );
}

function Overview({
  overview,
  cycles,
  currency,
  notice,
  weeks,
}: {
  overview: DashboardOverview;
  cycles: CycleOption[];
  currency: string;
  notice: string | null;
  weeks: number;
}) {
  const { cycle, kpis, weeklySeries, levelContribution, topContributors, topSponsors, heatmap } =
    overview;
  const options = cycles.some((option) => option.periodKey === cycle.periodKey)
    ? cycles
    : [cycle, ...cycles];

  const money = (value: number) => formatAmount(BigInt(Math.round(value)));
  const cents = (decimal: string) => Number(parseAmount(decimal));

  const weeklyLabels = weeklySeries.map((point) => shortPeriodKey(point.periodKey));

  return (
    <div className="space-y-8">
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
            <option value="12">12 semanas</option>
            <option value="26">26 semanas</option>
            <option value="52">52 semanas</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Ver
        </Button>
      </form>

      <section aria-label="Indicadores de la semana" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total recaudado" value={`${kpis.collectedTotal} ${currency}`} />
        <Stat label="Ticket promedio" value={`${kpis.averageTicket} ${currency}`} />
        <Stat
          label="Cumplimiento"
          value={`${(kpis.complianceRate * 100).toFixed(1)} %`}
          hint="Aportes aprobados sobre obligaciones de la semana"
        />
        <Stat label="Pendientes por revisar" value={String(kpis.pendingCount)} href="/admin/revisiones" />
        <Stat
          label="Aportes incumplidos"
          value={String(kpis.missedCount)}
          hint="Obligaciones de la semana sin aporte aprobado"
        />
        <Stat
          label="Usuarios nuevos"
          value={String(kpis.newUsersCount)}
          hint="Altas durante la semana en curso"
        />
        <Stat
          label="Tamaño de la red"
          value={String(kpis.networkSize)}
          hint="Personas activas en toda la red"
        />
      </section>

      <p className="text-xs text-muted-foreground">
        Las cifras corresponden a la semana {cycle.periodKey}; el tamaño de la red es el actual.
        «Cumplimiento» es aprobados sobre obligaciones de la semana.
      </p>

      <ChartSection title="Monto aprobado por semana">
        <BarChart
          points={weeklySeries.map((point) => {
            const value = cents(point.approvedTotal);
            return {
              label: shortPeriodKey(point.periodKey),
              value,
              valueLabel: money(value),
              hint: `${point.reportsCount} reportes`,
            };
          })}
          ariaLabel={`Monto aprobado por semana, últimas ${weeklySeries.length} semanas`}
        />
      </ChartSection>

      <ChartSection title="Reportes vs. obligaciones por semana">
        <LineChart
          labels={weeklyLabels}
          series={[
            {
              name: "Reportes",
              color: "primary",
              values: weeklySeries.map((point) => point.reportsCount),
            },
            {
              name: "Obligaciones",
              color: "secondary",
              values: weeklySeries.map((point) => point.obligationsCount),
            },
          ]}
          ariaLabel="Cantidad de reportes y obligaciones por semana"
        />
      </ChartSection>

      <ChartSection title="Aporte aprobado por nivel del árbol">
        <HorizontalBarChart
          rows={levelContribution.map((item) => {
            const value = cents(item.total);
            return {
              label: `Nivel ${item.level}`,
              value,
              valueLabel: money(value),
              hint: `${item.reports} reportes`,
            };
          })}
          ariaLabel="Monto aprobado por nivel"
          emptyText="Sin aportes aprobados en la semana."
        />
      </ChartSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartSection title="Top 10 contribuyentes de la semana">
          <HorizontalBarChart
            rows={topContributors.map((person) => {
              const value = cents(person.total);
              return {
                label: `${person.fullName} (${person.publicCode})`,
                value,
                valueLabel: money(value),
                hint: `${person.reports} reportes`,
              };
            })}
            ariaLabel="Los diez contribuyentes con mayor monto aprobado"
            emptyText="Sin aportes aprobados en la semana."
          />
        </ChartSection>

        <ChartSection title="Top 10 patrocinadores por red">
          <HorizontalBarChart
            rows={topSponsors.map((person) => {
              const value = cents(person.total);
              return {
                label: `${person.fullName} (${person.publicCode})`,
                value,
                valueLabel: money(value),
                hint: `${person.reports} reportes`,
              };
            })}
            ariaLabel="Los diez patrocinadores con mayor aporte de su red"
            emptyText="Sin aportes aprobados en la semana."
          />
        </ChartSection>
      </div>

      <ChartSection
        title="Mapa de calor: cumplimiento por semana y nivel"
        action={
          <Link href="/admin/cumplimiento" className="text-xs font-medium text-primary hover:underline">
            Ver la matriz completa →
          </Link>
        }
      >
        <ComplianceHeatmap
          periodKeys={heatmap.periodKeys}
          levels={heatmap.levels}
          cells={heatmap.cells}
        />
      </ChartSection>
    </div>
  );
}

function ChartSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href?: string;
  hint?: string;
}) {
  const content = (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">
        {value}
        {href ? <span className="ml-1 text-xs font-normal text-primary">→</span> : null}
      </dd>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="rounded-lg border bg-background p-3 transition-colors hover:bg-muted/50">
        {content}
      </Link>
    );
  }
  return <div className="rounded-lg border bg-background p-3">{content}</div>;
}

/** The effective overview, with the same graceful fallback as /admin/reportes. */
async function loadOverview(
  dashboard: DashboardService,
  actor: SessionActor,
  requestedKey: string | undefined,
  weeks: number,
): Promise<{ overview: DashboardOverview | null; notice: string | null }> {
  try {
    return {
      overview: await dashboard.getOverview(actor, { periodKey: requestedKey, weeks }),
      notice: null,
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    if (requestedKey !== undefined) {
      // The week in the URL does not exist: fall back to the current one
      // instead of trading the whole dashboard for an error screen.
      try {
        return {
          overview: await dashboard.getOverview(actor, { weeks }),
          notice: `La semana ${requestedKey} no existe; se muestra la semana vigente.`,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof NotFoundError)) throw fallbackError;
      }
    }
    return { overview: null, notice: null };
  }
}
