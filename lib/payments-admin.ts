// =============================================================================
// lib/payments-admin.ts — §8.5: the master payments table and its export.
//
// The client's headline requirement — "la raíz ve siempre y en detalle todos
// los reportes de pago: monto, fecha, quién y cuándo" — is answered here: one
// server-side listing with the twelve mandatory filters, real pagination and
// an export matrix that feeds CSV and XLSX from the SAME row objects the
// screen renders (D51).
//
// WHO MAY READ
// ------------
// Staff only (ROOT/ADMIN): the amounts, references and review notes of the
// whole network are exactly what §8.5 protects. On top of that the statement
// still flows through `authz.scopeFilter` like every other read (the doctrine
// in lib/authz.ts), so when staff scoping ever narrows, this table narrows
// with it instead of having to be found and fixed.
//
// FILTERS (D51)
// -------------
// The twelve filters of §8.5 arrive as URL query params and are normalized
// HERE, server-side: a malformed value is dropped (never passed to SQL), a
// reversed range is swapped, and the custom-field filters (`cf_<code>`) are
// only honored for fields the dashboard actually exposes. Money ranges bind
// as DECIMAL strings cast to `numeric` — never floats.
//
// EXPORT
// ------
// `exportRows` refuses to build a file above PAYMENTS_EXPORT_MAX_ROWS rows:
// a 400 that tells the operator how to narrow the download beats a route that
// quietly truncates the church's ledger. `selectedRows` does the same for the
// "exportar selección" bulk action.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError, isStaffActor, type SessionActor } from "./authz";
import { formatCustomValue } from "./custom-fields";
import { ValidationError, type Paginated } from "./errors";
import { dateLabel } from "./reports";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface PaymentsAdminDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Authorization surface (lib/authz satisfies it). */
export interface PaymentsAdminAuthz {
  scopeFilter(
    actor: SessionActor,
    options?: { alias?: string },
  ): Promise<{ fragment: Prisma.Sql; unrestricted: boolean }>;
}

export const PAYMENT_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type PaymentStatusFilter = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendiente",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
};

export type PaymentsDateField = "paid_at" | "reported_at";

export interface PaymentsCustomFieldFilter {
  code: string;
  value: string;
}

/** Normalized, validated filter set. Malformed input never reaches SQL. */
export interface PaymentsAdminFilters {
  /** Filter 1 — multi-select of period_key. */
  cycles: string[];
  /** Filter 2 — which date the range applies to. */
  dateField: PaymentsDateField;
  /** Filter 2 — UTC calendar day, inclusive. */
  dateFrom: Date | null;
  dateTo: Date | null;
  /** Filter 3. */
  status: PaymentStatusFilter | null;
  /** Filter 4. */
  userId: string | null;
  /** Filter 5 — "pagos de la red de X" over the report's snapshot_path. */
  subtreeOf: string | null;
  /** Filter 6 — exact level is levelMin === levelMax. */
  levelMin: number | null;
  levelMax: number | null;
  /** Filter 7. */
  methodId: string | null;
  /** Filter 8 — DECIMAL strings, cast to numeric in SQL. */
  minAmount: string | null;
  maxAmount: string | null;
  /** Filter 9. */
  currency: string | null;
  /** Filter 10. */
  proofs: "yes" | "no" | null;
  /** Filter 11 — reference or note. */
  q: string | null;
  /** Filter 12 — one entry per `cf_<code>` param of a dashboard field. */
  customFields: PaymentsCustomFieldFilter[];
  page: number;
  pageSize: number;
}

export const PAYMENTS_PAGE_SIZE_DEFAULT = 50;
export const PAYMENTS_PAGE_SIZE_MAX = 200;
export const PAYMENTS_EXPORT_MAX_ROWS = 10_000;

export interface PaymentRow {
  reportId: string;
  periodKey: string;
  paidAt: Date;
  reportedAt: Date;
  userId: string;
  userName: string;
  userCode: string;
  level: number;
  sponsorName: string | null;
  sponsorCode: string | null;
  /** DECIMAL string (A14). */
  amount: string;
  currency: string;
  /** Catalog label when linked, legacy enum text otherwise. */
  method: string | null;
  reference: string | null;
  status: PaymentStatusFilter;
  proofKey: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  /**
   * Values of the dashboard-visible PAYMENT_REPORT fields, keyed by field
   * `code` (D57). Always present: the row query aggregates it with a lateral
   * `jsonb_object_agg`, defaulting to `{}` when the report has no values.
   */
  custom: Record<string, unknown>;
}

export type PaymentsPage = Paginated<PaymentRow>;

export interface PaymentsAdminService {
  /** One page of the master table plus the total for the paginator. */
  listPayments(actor: SessionActor, filters: PaymentsAdminFilters): Promise<PaymentsPage>;
  /** Every matching row (hard cap: PAYMENTS_EXPORT_MAX_ROWS), same order. */
  exportRows(actor: SessionActor, filters: PaymentsAdminFilters): Promise<PaymentRow[]>;
  /** The selection export: rows addressed by id, cap included. */
  selectedRows(actor: SessionActor, ids: readonly string[]): Promise<PaymentRow[]>;
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

export interface SearchParamsLike {
  get(name: string): string | null;
  getAll(name: string): string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const CURRENCY_RE = /^[a-zA-Z]{3}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const Q_MAX = 120;
const LEVEL_MAX = 99;

function trimmed(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

function asUuid(value: string | null): string | null {
  return value !== null && UUID_RE.test(value) ? value : null;
}

/** A real UTC calendar day — 2026-02-31 round-trips to March and is rejected. */
function asDay(value: string | null): Date | null {
  if (value === null) return null;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

function asLevel(value: string | null): number | null {
  if (value === null || !/^\d{1,2}$/.test(value)) return null;
  const level = Number(value);
  return level <= LEVEL_MAX ? level : null;
}

function asPositiveInt(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 ? parsed : null;
}

/**
 * Normalize query params into a filter set. Anything malformed is dropped so
 * a hand-edited URL degrades to "fewer filters", never to a 500 or a wider
 * read than intended.
 */
export function parsePaymentsFilters(
  input: SearchParamsLike,
  options: { customFieldCodes?: readonly string[] } = {},
): PaymentsAdminFilters {
  const cycles = input
    .getAll("cycles")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const dateField: PaymentsDateField =
    input.get("dateField") === "paid_at" ? "paid_at" : "reported_at";

  let dateFrom = asDay(trimmed(input.get("dateFrom")));
  let dateTo = asDay(trimmed(input.get("dateTo")));
  // A reversed range is an intention, not an error to punish: swap it.
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }

  const rawStatus = trimmed(input.get("status"));
  const status = (PAYMENT_STATUSES as readonly string[]).includes(rawStatus ?? "")
    ? (rawStatus as PaymentStatusFilter)
    : null;

  let levelMin = asLevel(trimmed(input.get("levelMin")));
  let levelMax = asLevel(trimmed(input.get("levelMax")));
  if (levelMin !== null && levelMax !== null && levelMin > levelMax) {
    [levelMin, levelMax] = [levelMax, levelMin];
  }

  const minAmount = (() => {
    const value = trimmed(input.get("minAmount"));
    return value !== null && AMOUNT_RE.test(value) ? value : null;
  })();
  const maxAmount = (() => {
    const value = trimmed(input.get("maxAmount"));
    return value !== null && AMOUNT_RE.test(value) ? value : null;
  })();

  const currencyRaw = trimmed(input.get("currency"));
  const currency =
    currencyRaw !== null && CURRENCY_RE.test(currencyRaw) ? currencyRaw.toUpperCase() : null;

  const proofRaw = trimmed(input.get("proofs"));
  const proofs = proofRaw === "yes" || proofRaw === "no" ? proofRaw : null;

  const qRaw = trimmed(input.get("q"));
  const q = qRaw === null ? null : qRaw.slice(0, Q_MAX);

  const customFields: PaymentsCustomFieldFilter[] = [];
  // Only codes the dashboard actually exposes can filter; iterating the known
  // set (not the params) means an unknown `cf_x` is simply not a filter.
  for (const code of options.customFieldCodes ?? []) {
    const raw = trimmed(input.get(`cf_${code}`));
    if (raw !== null) customFields.push({ code, value: raw.slice(0, Q_MAX) });
  }

  const page = asPositiveInt(trimmed(input.get("page"))) ?? 1;
  const pageSize = Math.min(
    asPositiveInt(trimmed(input.get("page_size"))) ?? PAYMENTS_PAGE_SIZE_DEFAULT,
    PAYMENTS_PAGE_SIZE_MAX,
  );

  return {
    cycles,
    dateField,
    dateFrom,
    dateTo,
    status,
    userId: asUuid(trimmed(input.get("userId"))),
    subtreeOf: asUuid(trimmed(input.get("subtreeOf"))),
    levelMin,
    levelMax,
    methodId: asUuid(trimmed(input.get("methodId"))),
    minAmount,
    maxAmount,
    currency,
    proofs,
    q,
    customFields,
    page,
    pageSize,
  };
}

/** True when nothing but pagination was asked for. */
export function hasActiveFilters(filters: PaymentsAdminFilters): boolean {
  return (
    filters.cycles.length > 0 ||
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    filters.status !== null ||
    filters.userId !== null ||
    filters.subtreeOf !== null ||
    filters.levelMin !== null ||
    filters.levelMax !== null ||
    filters.methodId !== null ||
    filters.minAmount !== null ||
    filters.maxAmount !== null ||
    filters.currency !== null ||
    filters.proofs !== null ||
    filters.q !== null ||
    filters.customFields.length > 0
  );
}

// -----------------------------------------------------------------------------
// SQL building
// -----------------------------------------------------------------------------

const FROM_SQL = Prisma.sql`
  FROM payment_reports r
  JOIN payment_cycles c ON c.id = r.cycle_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users s ON s.id = u.sponsor_id
  LEFT JOIN payment_methods pm ON pm.id = r.method_id
  LEFT JOIN users rv ON rv.id = r.reviewed_by
`;

const ROW_COLUMNS_SQL = Prisma.sql`
  r.id AS "reportId", c.period_key AS "periodKey",
  r.paid_at AS "paidAt", r.reported_at AS "reportedAt",
  u.id AS "userId", u.full_name AS "userName", u.public_code AS "userCode",
  u.depth AS level,
  s.full_name AS "sponsorName", s.public_code AS "sponsorCode",
  r.amount::text AS amount, r.currency,
  COALESCE(pm.label, r.method::text) AS method,
  r.reference AS reference, r.status::text AS status,
  r.proof_key AS "proofKey",
  rv.full_name AS "reviewedByName", r.reviewed_at AS "reviewedAt",
  r.review_note AS "reviewNote",
  COALESCE(cfd.custom, '{}'::jsonb) AS "custom"
`;

/**
 * The dashboard-visible custom values of one report, aggregated by field code
 * in a lateral join (D57). Only fields the admin flagged for the dashboard
 * AND still active travel: the export columns and the filter row share
 * exactly this set, so a column can never exist without its filter.
 */
const CUSTOM_VALUES_JOIN_SQL = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(cf.code, cfv.value) AS custom
    FROM custom_field_values cfv
    JOIN custom_fields cf ON cf.id = cfv.field_id
    WHERE cfv.entity_id = r.id
      AND cf.entity = 'PAYMENT_REPORT' AND cf.is_active AND cf.show_in_dashboard
  ) cfd ON true
`;

/** Row reads (and only those) carry the aggregated custom values. */
const ROW_FROM_SQL = Prisma.sql`${FROM_SQL} ${CUSTOM_VALUES_JOIN_SQL}`;

function scopeCondition(scope: { fragment: Prisma.Sql; unrestricted: boolean }): Prisma.Sql | null {
  // Doctrine (lib/authz.ts): every read passes through scopeFilter. For staff
  // the fragment is empty; if roles ever gain a narrower staff scope this
  // table inherits it without edits.
  if (scope.unrestricted || scope.fragment.sql.trim() === "") return null;
  return scope.fragment;
}

function buildWhere(
  filters: PaymentsAdminFilters,
  scope: { fragment: Prisma.Sql; unrestricted: boolean },
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  const scopeSql = scopeCondition(scope);
  if (scopeSql !== null) conditions.push(scopeSql);

  if (filters.cycles.length > 0) {
    conditions.push(Prisma.sql`c.period_key IN (${Prisma.join(filters.cycles)})`);
  }

  const dateColumn = filters.dateField === "paid_at" ? Prisma.raw("r.paid_at") : Prisma.raw("r.reported_at");
  if (filters.dateFrom !== null) {
    conditions.push(Prisma.sql`${dateColumn} >= ${filters.dateFrom}`);
  }
  if (filters.dateTo !== null) {
    // Inclusive calendar day: everything before the next UTC midnight.
    const exclusive = new Date(filters.dateTo.getTime() + 24 * 60 * 60 * 1000);
    conditions.push(Prisma.sql`${dateColumn} < ${exclusive}`);
  }

  if (filters.status !== null) {
    conditions.push(Prisma.sql`r.status = ${filters.status}::report_status`);
  }
  if (filters.userId !== null) {
    conditions.push(Prisma.sql`u.id = ${filters.userId}::uuid`);
  }
  if (filters.subtreeOf !== null) {
    // "Pagos de la red de X": the reporter's path AT SUBMISSION TIME falls
    // under X's current path. The snapshot is what makes the answer to "who
    // was under X when they paid" stable even after the tree moves.
    conditions.push(
      Prisma.sql`r.snapshot_path <@ (SELECT path FROM users WHERE id = ${filters.subtreeOf}::uuid)`,
    );
  }
  if (filters.levelMin !== null) {
    conditions.push(Prisma.sql`u.depth >= ${filters.levelMin}`);
  }
  if (filters.levelMax !== null) {
    conditions.push(Prisma.sql`u.depth <= ${filters.levelMax}`);
  }
  if (filters.methodId !== null) {
    conditions.push(Prisma.sql`r.method_id = ${filters.methodId}::uuid`);
  }
  if (filters.minAmount !== null) {
    conditions.push(Prisma.sql`r.amount >= ${filters.minAmount}::numeric`);
  }
  if (filters.maxAmount !== null) {
    conditions.push(Prisma.sql`r.amount <= ${filters.maxAmount}::numeric`);
  }
  if (filters.currency !== null) {
    conditions.push(Prisma.sql`upper(r.currency) = ${filters.currency}`);
  }
  if (filters.proofs === "yes") {
    conditions.push(Prisma.sql`r.proof_key IS NOT NULL`);
  } else if (filters.proofs === "no") {
    conditions.push(Prisma.sql`r.proof_key IS NULL`);
  }
  if (filters.q !== null) {
    // One search box for the whole row: the person (name, code, email), the
    // reference, the report note and the review note.
    conditions.push(
      Prisma.sql`(
        r.reference ILIKE '%' || ${filters.q} || '%'
        OR r.note ILIKE '%' || ${filters.q} || '%'
        OR u.full_name ILIKE '%' || ${filters.q} || '%'
        OR u.public_code ILIKE '%' || ${filters.q} || '%'
        OR u.email::text ILIKE '%' || ${filters.q} || '%'
        OR r.review_note ILIKE '%' || ${filters.q} || '%'
      )`,
    );
  }
  for (const custom of filters.customFields) {
    conditions.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM custom_field_values cfv
        JOIN custom_fields cf ON cf.id = cfv.field_id
        WHERE cfv.entity_id = r.id AND cf.code = ${custom.code}
          AND cfv.value::text ILIKE '%' || ${custom.value} || '%'
      )`,
    );
  }

  if (conditions.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(conditions, " AND ");
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export function createPaymentsAdminService(
  db: PaymentsAdminDb,
  authz: PaymentsAdminAuthz,
): PaymentsAdminService {
  const requireStaff = (actor: SessionActor): void => {
    if (!isStaffActor(actor)) {
      // D39/D51: amounts and references of the whole network are staff
      // business. No SQL on refusal. Non-staff reads keep their own door.
      throw new ForbiddenError("payments:admin requires a staff actor");
    }
  };

  const readRows = async (
    where: Prisma.Sql,
    limit?: number,
    offset?: number,
  ): Promise<PaymentRow[]> => {
    const limitSql = limit === undefined ? Prisma.sql`` : Prisma.sql`LIMIT ${limit}`;
    const offsetSql = offset === undefined || offset === 0 ? Prisma.sql`` : Prisma.sql`OFFSET ${offset}`;
    return db.$queryRaw<PaymentRow[]>`
      /* @payadmin:rows */
      SELECT ${ROW_COLUMNS_SQL}
      ${ROW_FROM_SQL}
      WHERE ${where}
      ORDER BY r.reported_at DESC, r.id DESC
      ${limitSql}
      ${offsetSql}
    `;
  };

  return {
    async listPayments(actor, filters) {
      requireStaff(actor);
      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const where = buildWhere(filters, scope);
      const offset = (filters.page - 1) * filters.pageSize;

      const [countRows, rows] = await Promise.all([
        db.$queryRaw<Array<{ total: number }>>`
          /* @payadmin:count */
          SELECT COUNT(*)::int AS total
          ${FROM_SQL}
          WHERE ${where}
        `,
        readRows(where, filters.pageSize, offset),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows,
        page: filters.page,
        perPage: filters.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / filters.pageSize),
      };
    },

    async exportRows(actor, filters) {
      requireStaff(actor);
      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const where = buildWhere(filters, scope);

      // cap + 1: the extra row is how the service KNOWS it was cut, instead
      // of shipping a silently truncated ledger.
      const rows = await readRows(where, PAYMENTS_EXPORT_MAX_ROWS + 1);
      if (rows.length > PAYMENTS_EXPORT_MAX_ROWS) {
        throw new ValidationError(
          `La exportación supera el máximo de ${PAYMENTS_EXPORT_MAX_ROWS.toLocaleString("es")} filas. Ajusta los filtros o divide la descarga.`,
        );
      }
      return rows;
    },

    async selectedRows(actor, ids) {
      requireStaff(actor);
      const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => UUID_RE.test(id)))];
      if (unique.length === 0) {
        throw new ValidationError("No se seleccionó ningún pago para exportar.");
      }
      if (unique.length > PAYMENTS_EXPORT_MAX_ROWS) {
        throw new ValidationError(
          `La selección supera el máximo de ${PAYMENTS_EXPORT_MAX_ROWS.toLocaleString("es")} filas.`,
        );
      }

      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const conditions: Prisma.Sql[] = [];
      const scopeSql = scopeCondition(scope);
      if (scopeSql !== null) conditions.push(scopeSql);
      conditions.push(
        Prisma.sql`r.id IN (${Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`))})`,
      );

      return db.$queryRaw<PaymentRow[]>`
        /* @payadmin:selected */
        SELECT ${ROW_COLUMNS_SQL}
        ${ROW_FROM_SQL}
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY r.reported_at DESC, r.id DESC
      `;
    },
  };
}

// -----------------------------------------------------------------------------
// Export matrix — screen, CSV and XLSX share this one definition (D51/D57)
// -----------------------------------------------------------------------------

/** The 16 fixed §8.5 columns; the dynamic ones are appended (D57). */
export const PAYMENTS_HEADERS = [
  "Semana",
  "Fecha de pago",
  "Fecha de reporte",
  "Usuario",
  "Código",
  "Nivel",
  "Patrocinador",
  "Monto",
  "Moneda",
  "Método",
  "Referencia",
  "Estado",
  "Comprobante",
  "Revisado por",
  "Revisado el",
  "Nota",
] as const;

/** One dashboard-visible PAYMENT_REPORT field = one extra column (D57). */
export interface PaymentsExportField {
  code: string;
  label: string;
}

const DASH = "-";

/** The fixed headers plus one per dashboard field, in the service's order. */
export function paymentsHeaders(fields: readonly PaymentsExportField[] = []): string[] {
  return [...PAYMENTS_HEADERS, ...fields.map((field) => field.label)];
}

export function paymentsMatrix(
  rows: readonly PaymentRow[],
  fields: readonly PaymentsExportField[] = [],
): string[][] {
  return rows.map((row) => [
    row.periodKey,
    dateLabel(row.paidAt),
    dateLabel(row.reportedAt),
    row.userName,
    row.userCode,
    String(row.level),
    row.sponsorName ?? DASH,
    row.amount,
    row.currency,
    row.method ?? DASH,
    row.reference ?? DASH,
    PAYMENT_STATUS_LABELS[row.status] ?? row.status,
    row.proofKey === null ? "No" : "Sí",
    row.reviewedByName ?? DASH,
    row.reviewedAt === null ? DASH : dateLabel(row.reviewedAt),
    row.reviewNote ?? DASH,
    ...fields.map((field) => {
      const text = formatCustomValue(row.custom?.[field.code]);
      return text === "" ? DASH : text;
    }),
  ]);
}

/** `pagos-2026-10-15`; the route appends the extension. */
export function paymentsFileBase(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  const day = String(at.getUTCDate()).padStart(2, "0");
  return `pagos-${year}-${month}-${day}`;
}
