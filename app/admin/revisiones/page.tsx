import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { buttonVariants } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { formatCustomValue } from "@/lib/custom-fields";
import { createDashboardService } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { createPaymentsService } from "@/lib/payments";
import { createReportsService, dateLabel } from "@/lib/reports";
import { settings } from "@/lib/settings";
import { cn } from "@/lib/utils";

import { ReviewClient, type ReviewRow } from "./review-client";

// =============================================================================
// app/admin/revisiones/page.tsx — the §8.5 offering review queue.
//
// Pending reports, oldest first (the service orders them), filtered and paged
// through GET params: the URL is the state, so a filtered queue is a shareable
// link. Approving fulfils the week's obligation and notifies the member;
// rejecting demands a motive. Everything happens in
// reviewPaymentReportAction → lib/payments.ts; this page only reads.
//
// ReviewClient renders even when the page is empty: its success message must
// survive the router.refresh() that follows the last approval (the empty state
// used to swap the component out and lose it).
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export default async function ReviewPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/revisiones");
  const params = await searchParams;

  const payments = createPaymentsService(prisma, settings, authorization);
  const reports = createReportsService(prisma, authorization);
  const dashboard = createDashboardService(prisma, authorization);

  const [cycles, methods] = await Promise.all([
    reports.listCycles(session),
    dashboard.listPaymentMethods(session),
  ]);

  const requestedCycle = textParam(params.cycle);
  const requestedMethod = textParam(params.method);
  const cycle = cycles.find((option) => option.periodKey === requestedCycle) ?? null;
  const method = methods.some((option) => option.code === requestedMethod) ? requestedMethod : null;
  const q = textParam(params.q).trim().slice(0, 120);
  const proof = textParam(params.proof);
  const page = positiveInt(params.page);
  const pageSize = parsePageSize(params.page_size);

  const hasProof = proof === "yes" ? true : proof === "no" ? false : null;
  const offset = (page - 1) * pageSize;

  const queue = await payments.listReviewQueue(
    { id: session.userId, role: session.role },
    { cycleId: cycle?.id ?? null, method, q, hasProof, limit: pageSize, offset },
  );

  const rows: ReviewRow[] = queue.rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    publicCode: row.publicCode,
    periodKey: row.periodKey,
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    note: row.note,
    proofKey: row.proofKey,
    paidAtLabel: dateLabel(row.paidAt),
    reportedAtLabel: dateLabel(row.reportedAt),
    customValues: row.customValues
      .map((entry) => ({ label: entry.label, value: formatCustomValue(entry.value) }))
      .filter((entry) => entry.value !== ""),
  }));

  const totalPages = Math.max(1, Math.ceil(queue.total / pageSize));
  const firstRow = queue.total === 0 ? 0 : offset + 1;
  const lastRow = Math.min(offset + rows.length, queue.total);
  const filtersActive = cycle !== null || method !== null || q !== "" || hasProof !== null;
  const query = filterQuery({ cycle: cycle?.periodKey ?? null, method, q, hasProof, pageSize });

  return (
    <SessionShell
      session={session}
      title="Revisión de aportes"
      description="Aportes pendientes de revisión. Aprobar cumple la obligación; rechazar pide un motivo."
    >
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          {queue.total === 0
            ? "Sin resultados con los filtros actuales."
            : `${queue.total.toLocaleString("es")} aportes · mostrando ${firstRow}–${lastRow}`}
        </p>

        <form method="get" className="grid gap-4 rounded-lg border bg-background p-4 lg:grid-cols-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Semana</span>
            <select
              name="cycle"
              defaultValue={cycle?.periodKey ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todas</option>
              {cycles.map((option) => (
                <option key={option.id} value={option.periodKey}>
                  {option.periodKey} · {dateLabel(option.startsAt)} – {dateLabel(option.endsAt)}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Método</span>
            <select
              name="method"
              defaultValue={method ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {methods.map((option) => (
                <option key={option.id} value={option.code}>
                  {option.label}
                  {option.isActive ? "" : " (inactivo)"}
                </option>
              ))}
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
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Comprobante</span>
            <select
              name="proof"
              defaultValue={hasProof === null ? "" : hasProof ? "yes" : "no"}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              <option value="yes">Con comprobante</option>
              <option value="no">Sin comprobante</option>
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Filas por página
            </span>
            <select
              name="page_size"
              defaultValue={String(pageSize)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end gap-2 lg:col-span-4">
            <button type="submit" className={cn(buttonVariants(), "h-10")}>
              Filtrar
            </button>
            {filtersActive ? (
              <Link
                href="/admin/revisiones"
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Limpiar filtros
              </Link>
            ) : null}
          </div>
        </form>

        <ReviewClient rows={rows} />

        {totalPages > 1 ? (
          <nav className="flex items-center justify-end gap-3 text-sm" aria-label="Paginación">
            {page > 1 ? (
              <Link
                href={`/admin/revisiones?${pageQuery(query, page - 1)}`}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Anterior
              </Link>
            ) : null}
            <span className="text-muted-foreground">
              Página {page} de {totalPages}
            </span>
            {page < totalPages ? (
              <Link
                href={`/admin/revisiones?${pageQuery(query, page + 1)}`}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Siguiente
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </SessionShell>
  );
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

/** The three supported page sizes; anything else falls back to 25. */
function parsePageSize(value: string | string[] | undefined): (typeof PAGE_SIZES)[number] {
  const raw = typeof value === "string" ? Number(value) : Number.NaN;
  return (PAGE_SIZES as readonly number[]).includes(raw)
    ? (raw as (typeof PAGE_SIZES)[number])
    : DEFAULT_PAGE_SIZE;
}

/** Normalized filters for the pagination links — no `page`, no unknown values. */
function filterQuery(filters: {
  cycle: string | null;
  method: string | null;
  q: string;
  hasProof: boolean | null;
  pageSize: number;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.cycle !== null) query.set("cycle", filters.cycle);
  if (filters.method !== null) query.set("method", filters.method);
  if (filters.q !== "") query.set("q", filters.q);
  if (filters.hasProof !== null) query.set("proof", filters.hasProof ? "yes" : "no");
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) query.set("page_size", String(filters.pageSize));
  return query;
}

function pageQuery(query: URLSearchParams, page: number): string {
  const next = new URLSearchParams(query);
  next.set("page", String(page));
  return next.toString();
}
