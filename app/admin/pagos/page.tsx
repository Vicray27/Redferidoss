import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { buttonVariants } from "@/components/ui/button";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { createDashboardService } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import {
  createPaymentsAdminService,
  hasActiveFilters,
  parsePaymentsFilters,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  PAYMENTS_PAGE_SIZE_DEFAULT,
  PAYMENTS_PAGE_SIZE_MAX,
  type PaymentsAdminFilters,
  type SearchParamsLike,
} from "@/lib/payments-admin";
import { createReportsService, dateLabel } from "@/lib/reports";
import { cn } from "@/lib/utils";

import { PaymentsTable, type PaymentsTableRow } from "./payments-table";
import { UserPickerField } from "./user-picker";

// =============================================================================
// app/admin/pagos/page.tsx — §8.5: the master payments table.
//
// Twelve filters, all as GET params: the state lives in the URL, so a filtered
// view is a shareable link and the back button works. The page itself is a
// thin face over `createPaymentsAdminService` — it renders the form, maps the
// rows to display values, and hands the selection toolbar the cycles. Every
// filter value is normalized by `parsePaymentsFilters` BEFORE any read
// (D51): a hand-edited URL degrades to fewer filters, never to a 500.
// =============================================================================

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PaymentsAdminPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireStaffSession("/admin/pagos");
  const params = await searchParams;

  const admin = createPaymentsAdminService(prisma, authorization);
  const dashboard = createDashboardService(prisma, authorization);
  const reports = createReportsService(prisma, authorization);

  // The custom-field codes must be known BEFORE parsing: an unknown `cf_x`
  // param is not a filter (D51), and only the database knows the real codes.
  const [cycles, methods, customFields] = await Promise.all([
    reports.listCycles(session),
    dashboard.listPaymentMethods(session),
    dashboard.listDashboardCustomFields(session),
  ]);

  const filters = parsePaymentsFilters(toSearchParams(params), {
    customFieldCodes: customFields.map((field) => field.code),
  });

  const [page, userOption, subtreeOption] = await Promise.all([
    admin.listPayments(session, filters),
    filters.userId ? dashboard.userOption(session, filters.userId) : Promise.resolve(null),
    filters.subtreeOf ? dashboard.userOption(session, filters.subtreeOf) : Promise.resolve(null),
  ]);

  const rows: PaymentsTableRow[] = page.items.map((row) => ({
    id: row.reportId,
    periodKey: row.periodKey,
    paidAtLabel: dateLabel(row.paidAt),
    reportedAtLabel: dateLabel(row.reportedAt),
    userId: row.userId,
    userName: row.userName,
    userCode: row.userCode,
    level: row.level,
    sponsorName: row.sponsorName,
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    statusLabel: PAYMENT_STATUS_LABELS[row.status] ?? row.status,
    proofKey: row.proofKey,
    reviewedByName: row.reviewedByName,
    reviewedAtLabel: row.reviewedAt === null ? null : dateLabel(row.reviewedAt),
    reviewNote: row.reviewNote,
  }));

  const query = filterQuery(filters);
  const exportSuffix = query.toString() === "" ? "" : `&${query.toString()}`;
  const firstRow = page.total === 0 ? 0 : (page.page - 1) * page.perPage + 1;
  const lastRow = Math.min(page.page * page.perPage, page.total);

  return (
    <SessionShell
      session={session}
      title="Pagos"
      description="Todos los reportes de pago de la red con doce filtros, acciones en lote y exportación. Solo staff."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-end gap-2">
          <p className="text-sm text-muted-foreground">
            {page.total === 0
              ? "Sin resultados con los filtros actuales."
              : `${page.total.toLocaleString("es")} pagos · mostrando ${firstRow}–${lastRow}`}
          </p>
          <div className="ml-auto flex flex-wrap gap-2">
            <a
              href={`/api/payments/export?format=xlsx${exportSuffix}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Exportar Excel
            </a>
            <a
              href={`/api/payments/export?format=csv${exportSuffix}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Exportar CSV
            </a>
          </div>
        </div>

        <form method="get" className="grid gap-4 rounded-lg border bg-background p-4 lg:grid-cols-4">
          <label className="text-sm lg:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Semanas</span>
            <select
              name="cycles"
              multiple
              size={Math.min(Math.max(cycles.length, 1), 5)}
              defaultValue={filters.cycles}
              className="w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              {cycles.map((option) => (
                <option key={option.id} value={option.periodKey}>
                  {option.periodKey} · {dateLabel(option.startsAt)} – {dateLabel(option.endsAt)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              Sin selección = todas las semanas. Ctrl/Cmd para elegir varias.
            </span>
          </label>

          <div className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Rango de fechas
            </span>
            <select
              name="dateField"
              defaultValue={filters.dateField}
              className="mb-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="reported_at">Fecha de reporte</option>
              <option value="paid_at">Fecha de pago</option>
            </select>
            <div className="flex gap-2">
              <input
                type="date"
                name="dateFrom"
                defaultValue={dayValue(filters.dateFrom)}
                aria-label="Desde"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
              <input
                type="date"
                name="dateTo"
                defaultValue={dayValue(filters.dateTo)}
                aria-label="Hasta"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
            </div>
          </div>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Estado</span>
            <select
              name="status"
              defaultValue={filters.status ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {PAYMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {PAYMENT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>

          <UserPickerField
            name="userId"
            label="Usuario"
            placeholder="Nombre, código o correo…"
            initial={userOption}
          />

          <UserPickerField
            name="subtreeOf"
            label="Pagos de la red de"
            placeholder="Nombre, código o correo…"
            initial={subtreeOption}
          />

          <div className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Nivel</span>
            <div className="flex gap-2">
              <input
                type="number"
                name="levelMin"
                min={0}
                max={99}
                placeholder="Mín"
                defaultValue={filters.levelMin ?? ""}
                aria-label="Nivel mínimo"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
              <input
                type="number"
                name="levelMax"
                min={0}
                max={99}
                placeholder="Máx"
                defaultValue={filters.levelMax ?? ""}
                aria-label="Nivel máximo"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
            </div>
          </div>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Método</span>
            <select
              name="methodId"
              defaultValue={filters.methodId ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {methods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.label}
                  {method.isActive ? "" : " (inactivo)"}
                </option>
              ))}
            </select>
          </label>

          <div className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Monto</span>
            <div className="flex gap-2">
              <input
                type="text"
                name="minAmount"
                inputMode="decimal"
                placeholder="Mín"
                defaultValue={filters.minAmount ?? ""}
                aria-label="Monto mínimo"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
              <input
                type="text"
                name="maxAmount"
                inputMode="decimal"
                placeholder="Máx"
                defaultValue={filters.maxAmount ?? ""}
                aria-label="Monto máximo"
                className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
              />
            </div>
          </div>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Moneda</span>
            <input
              type="text"
              name="currency"
              maxLength={3}
              placeholder="USD"
              defaultValue={filters.currency ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm uppercase"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Comprobante
            </span>
            <select
              name="proofs"
              defaultValue={filters.proofs ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              <option value="yes">Con comprobante</option>
              <option value="no">Sin comprobante</option>
            </select>
          </label>

          <label className="text-sm lg:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Referencia o nota
            </span>
            <input
              type="text"
              name="q"
              maxLength={120}
              placeholder="Buscar en referencia o nota…"
              defaultValue={filters.q ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>

          {customFields.map((field) => {
            const current = filters.customFields.find((custom) => custom.code === field.code);
            return (
              <label key={field.id} className="text-sm">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {field.label}
                </span>
                <input
                  type="text"
                  name={`cf_${field.code}`}
                  defaultValue={current?.value ?? ""}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
            );
          })}

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Filas por página
            </span>
            <select
              name="page_size"
              defaultValue={String(filters.pageSize)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {[50, 100, PAYMENTS_PAGE_SIZE_MAX].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end gap-2 lg:col-span-4">
            <button
              type="submit"
              className={cn(buttonVariants(), "h-10")}
            >
              Filtrar
            </button>
            {hasActiveFilters(filters) ? (
              <Link href="/admin/pagos" className={cn(buttonVariants({ variant: "outline" }))}>
                Limpiar filtros
              </Link>
            ) : null}
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
            No hay pagos que coincidan con los filtros.
          </p>
        ) : (
          <PaymentsTable
            rows={rows}
            cycles={cycles.map((cycle) => ({ id: cycle.id, periodKey: cycle.periodKey }))}
          />
        )}

        {page.totalPages > 1 ? (
          <nav className="flex items-center justify-end gap-3 text-sm" aria-label="Paginación">
            {page.page > 1 ? (
              <Link
                href={`/admin/pagos?${pageQuery(query, page.page - 1)}`}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Anterior
              </Link>
            ) : null}
            <span className="text-muted-foreground">
              Página {page.page} de {page.totalPages}
            </span>
            {page.page < page.totalPages ? (
              <Link
                href={`/admin/pagos?${pageQuery(query, page.page + 1)}`}
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

/** `searchParams` as the service's SearchParamsLike (multi-values preserved). */
function toSearchParams(params: Record<string, string | string[] | undefined>): SearchParamsLike {
  const values = new Map<string, string[]>();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") values.set(key, [value]);
    else if (Array.isArray(value)) {
      values.set(
        key,
        value.filter((item): item is string => typeof item === "string"),
      );
    }
  }
  return {
    get: (name) => values.get(name)?.[0] ?? null,
    getAll: (name) => [...(values.get(name) ?? [])],
  };
}

/** Canonical query string for export links: the normalized filters, nothing else. */
function filterQuery(filters: PaymentsAdminFilters): URLSearchParams {
  const query = new URLSearchParams();
  filters.cycles.forEach((cycle) => query.append("cycles", cycle));
  if (filters.dateField === "paid_at") query.set("dateField", "paid_at");
  const from = dayValue(filters.dateFrom);
  if (from !== "") query.set("dateFrom", from);
  const to = dayValue(filters.dateTo);
  if (to !== "") query.set("dateTo", to);
  if (filters.status !== null) query.set("status", filters.status);
  if (filters.userId !== null) query.set("userId", filters.userId);
  if (filters.subtreeOf !== null) query.set("subtreeOf", filters.subtreeOf);
  if (filters.levelMin !== null) query.set("levelMin", String(filters.levelMin));
  if (filters.levelMax !== null) query.set("levelMax", String(filters.levelMax));
  if (filters.methodId !== null) query.set("methodId", filters.methodId);
  if (filters.minAmount !== null) query.set("minAmount", filters.minAmount);
  if (filters.maxAmount !== null) query.set("maxAmount", filters.maxAmount);
  if (filters.currency !== null) query.set("currency", filters.currency);
  if (filters.proofs !== null) query.set("proofs", filters.proofs);
  if (filters.q !== null) query.set("q", filters.q);
  for (const custom of filters.customFields) query.set(`cf_${custom.code}`, custom.value);
  if (filters.pageSize !== PAYMENTS_PAGE_SIZE_DEFAULT) {
    query.set("page_size", String(filters.pageSize));
  }
  return query;
}

function pageQuery(query: URLSearchParams, page: number): string {
  const next = new URLSearchParams(query);
  next.set("page", String(page));
  return next.toString();
}

/** `YYYY-MM-DD` for a `<input type="date">` value; `""` when unset. */
function dayValue(date: Date | null): string {
  return date === null ? "" : date.toISOString().slice(0, 10);
}
