import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { buttonVariants } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import { requireStaffSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { formatCustomValue } from "@/lib/custom-fields";
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
  type PaymentsExportField,
  type SearchParamsLike,
} from "@/lib/payments-admin";
import { createReportsService, dateLabel, weekRangeLabel } from "@/lib/reports";
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

  // One dashboard-visible field = one extra column of the table AND of the
  // export (D57): both read the same field list, so they cannot drift apart.
  const exportFields: PaymentsExportField[] = customFields.map((field) => ({
    code: field.code,
    label: field.label,
  }));

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
    customCells: exportFields.map((field) => {
      const text = formatCustomValue(row.custom?.[field.code]);
      return text === "" ? "—" : text;
    }),
  }));

  const query = filterQuery(filters);
  const exportSuffix = query.toString() === "" ? "" : `&${query.toString()}`;
  const firstRow = page.total === 0 ? 0 : (page.page - 1) * page.perPage + 1;
  const lastRow = Math.min(page.page * page.perPage, page.total);

  // "2026-W43" is a database key, not UI copy: every select and table cell
  // shows the friendly range and keeps the raw key only as a `title` tooltip.
  const weekLabels: Record<string, string> = Object.fromEntries(
    cycles.map((cycle) => [cycle.periodKey, weekRangeLabel(cycle.startsAt, cycle.endsAt)]),
  );

  // The advanced section opens by itself when it holds active filters, and the
  // summary counts them so a collapsed panel never hides why the list is short.
  const advancedFilterCount =
    (filters.dateField !== "reported_at" ? 1 : 0) +
    (filters.dateFrom !== null ? 1 : 0) +
    (filters.dateTo !== null ? 1 : 0) +
    (filters.levelMin !== null ? 1 : 0) +
    (filters.levelMax !== null ? 1 : 0) +
    (filters.minAmount !== null ? 1 : 0) +
    (filters.maxAmount !== null ? 1 : 0) +
    (filters.currency !== null ? 1 : 0) +
    filters.customFields.length +
    (filters.pageSize !== PAYMENTS_PAGE_SIZE_DEFAULT ? 1 : 0);

  return (
    <SessionShell
      session={session}
      title="Pagos"
      description="Todos los reportes de pago de la red con doce filtros, acciones en lote y exportación. Solo personal autorizado."
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

        <form method="get" className="space-y-4 rounded-lg border bg-background p-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <fieldset className="rounded-lg border bg-muted/10 p-4">
              <legend className="px-1 text-sm font-medium">Persona y red</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    Buscar persona o referencia
                  </span>
                  <input
                    type="text"
                    name="q"
                    maxLength={120}
                    placeholder="Nombre, correo, código, referencia o nota…"
                    defaultValue={filters.q ?? ""}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>

                <UserPickerField
                  name="userId"
                  label="Persona exacta"
                  placeholder="Nombre, código o correo…"
                  initial={userOption}
                />

                <UserPickerField
                  name="subtreeOf"
                  label="Pagos de la red de"
                  placeholder="Nombre, código o correo…"
                  initial={subtreeOption}
                />
              </div>
            </fieldset>

            <fieldset className="rounded-lg border bg-muted/10 p-4">
              <legend className="px-1 text-sm font-medium">Semanas</legend>
              <MultiSelect
                name="cycles"
                label="Semanas"
                options={cycles.map((option) => ({
                  value: option.periodKey,
                  label: weekRangeLabel(option.startsAt, option.endsAt),
                  secondary: option.periodKey,
                }))}
                selected={filters.cycles}
                emptyLabel="Todas las semanas"
                searchPlaceholder="Buscar semana…"
                summaryNoun="semana"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Elegí una o más semanas.
              </p>
            </fieldset>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
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
          </div>

          <details className="rounded-lg border bg-muted/10" open={advancedFilterCount > 0}>
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
              Más filtros
              {advancedFilterCount > 0
                ? ` · ${advancedFilterCount} ${advancedFilterCount === 1 ? "activo" : "activos"}`
                : ""}
            </summary>

            <div className="grid gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="text-sm sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Rango de fechas
                </span>
                <div className="flex flex-wrap gap-2">
                  <select
                    name="dateField"
                    defaultValue={filters.dateField}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm sm:w-auto"
                  >
                    <option value="reported_at">Fecha de reporte</option>
                    <option value="paid_at">Fecha de pago</option>
                  </select>
                  <input
                    type="date"
                    name="dateFrom"
                    defaultValue={dayValue(filters.dateFrom)}
                    aria-label="Desde"
                    className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm sm:w-auto"
                  />
                  <input
                    type="date"
                    name="dateTo"
                    defaultValue={dayValue(filters.dateTo)}
                    aria-label="Hasta"
                    className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm sm:w-auto"
                  />
                </div>
              </div>

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
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={cn(buttonVariants(), "h-10")}>
              Aplicar filtros
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
            weekLabels={weekLabels}
            customFields={exportFields}
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
