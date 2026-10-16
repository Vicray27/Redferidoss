// =============================================================================
// lib/reports.ts — §8.4/§8.5: the admin "planilla consolidada" of a cycle.
//
// ONE canonical row set for the selected week and ONE row->matrix shaper that
// the screen, the CSV, the XLSX and the print view all consume, so the four
// faces cannot drift: the totals are derived in JavaScript from the same rows
// the table renders, and the export matrix is, by construction, the table.
//
// WHO THE ROWS ARE (D38 + consolidation rule)
// -------------------------------------------
// Every non-deleted user with an obligation OR a weekly report OR an offering
// report in the cycle. D38 pins the two "missing activity" readings that this
// sheet counts separately:
//   * no weekly_reports row            -> "no reportó" (they owe, they were silent)
//   * a row whose whole activity is 0  -> "sin actividad" (they answered "nothing happened")
// Including a person who only appears through payment_reports is deliberate:
// a consolidated sheet must never show money that belongs to no row.
//
// AUTHORIZATION
// -------------
// Staff-only. §8.5 gives the dashboard to "la Persona #1" and D39 keeps the
// amounts (and the reference/proof behind them) visible to ROOT/ADMIN alone;
// a MEMBER is refused BEFORE any statement runs. The read still passes through
// `scopeFilter` — for staff it is unrestricted today, but the fragment is ANDed
// into the SQL exactly like every other §7.1 read, so the statement cannot
// become a leak if the guard above ever loosens.
//
// MONEY
// -----
// Amounts cross as DECIMAL strings and are summed in scaled BigInt cents
// (lib/money.ts, A14): `amountTotal` is the sum of every LIVE row amount
// (PENDING or APPROVED) — i.e. exactly the amounts the matrix shows — and
// `amountApproved` is the confirmed money. Count semantics are D48.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError, isStaffActor, type SessionActor } from "./authz";
import { NotFoundError } from "./errors";
import { addAmounts, formatAmount, parseAmount } from "./money";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface ReportsDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Authorization surface (lib/authz satisfies it). */
export interface ReportsAuthz {
  scopeFilter(actor: SessionActor, options?: { alias?: string }): Promise<{ fragment: Prisma.Sql; unrestricted: boolean }>;
}

export type ReportStatus = "PENDING" | "APPROVED" | "REJECTED";
/** `NONE` = no report at all for the cycle. */
export type OfferingState = "NONE" | ReportStatus;

export interface CycleOption {
  id: string;
  periodKey: string;
  startsAt: Date;
  endsAt: Date;
  dueAt: Date;
  status: string;
}

export interface ConsolidatedSheetRow {
  userId: string;
  fullName: string;
  publicCode: string;
  /** Absolute tree depth (`users.depth`, root = 0). */
  level: number;
  sponsorName: string | null;
  sponsorCode: string | null;
  /** A weekly_reports row exists for the cycle (D38). */
  reported: boolean;
  /** Reported, but every activity field is 0/false: "sin actividad" (D38). */
  noActivity: boolean;
  attended: boolean;
  discipleshipAttended: boolean;
  cellsTotal: number;
  cellsHeld: number;
  cellsNotHeld: number;
  cellAttendees: number;
  cellAbsentees: number;
  cellNewVisitors: number;
  cellNewCells: number;
  visitors: string[];
  note: string | null;
  offeringState: OfferingState;
  /** DECIMAL string, present whenever a report exists (any state). */
  amount: string | null;
  currency: string | null;
  /** `payment_method` enum code (TRANSFER, MOBILE, … or OTHER). */
  method: string | null;
  paidAt: Date | null;
}

export interface ConsolidatedSheetTotals {
  people: number;
  reported: number;
  notReported: number;
  attended: number;
  /** Live offerings: PENDING or APPROVED (a REJECTED report is not an offering). */
  offered: number;
  /** Sum of every live amount in the sheet — always the matrix's own sum. */
  amountTotal: string;
  /** Sum of APPROVED amounts only: the money the church confirmed. */
  amountApproved: string;
  visitors: number;
}

export interface ConsolidatedSheet {
  cycle: CycleOption;
  rows: ConsolidatedSheetRow[];
  totals: ConsolidatedSheetTotals;
}

export interface ReportsService {
  /** Cycle selector data, newest first. */
  listCycles(options?: { limit?: number }): Promise<CycleOption[]>;
  /** The consolidated sheet of one cycle (default: the current effective one). */
  getConsolidatedSheet(actor: SessionActor, selector?: { periodKey?: string }): Promise<ConsolidatedSheet>;
}

export interface ReportsServiceOptions {
  now?: () => Date;
}

const DEFAULT_CYCLES_LISTED = 52;
const MAX_CYCLES_LISTED = 104;

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(1, Math.trunc(raw)), max);
}

// -----------------------------------------------------------------------------
// Raw row -> domain row
// -----------------------------------------------------------------------------

interface SheetRawRow {
  userId: string;
  fullName: string;
  publicCode: string;
  level: number;
  sponsorName: string | null;
  sponsorCode: string | null;
  weeklyReportId: string | null;
  attended: boolean | null;
  discipleshipAttended: boolean | null;
  cellsTotal: number | null;
  cellsHeld: number | null;
  cellsNotHeld: number | null;
  cellAttendees: number | null;
  cellAbsentees: number | null;
  cellNewVisitors: number | null;
  cellNewCells: number | null;
  visitors: unknown;
  note: string | null;
  reportId: string | null;
  offeringStatus: string | null;
  amount: string | null;
  currency: string | null;
  method: string | null;
  paidAt: Date | null;
}

/** JSONB can arrive as anything; only a list of non-empty strings is valid. */
function normalizeVisitors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

export function toConsolidatedRow(raw: SheetRawRow): ConsolidatedSheetRow {
  const reported = raw.weeklyReportId !== null;
  const counters = [
    raw.cellsTotal,
    raw.cellsHeld,
    raw.cellsNotHeld,
    raw.cellAttendees,
    raw.cellAbsentees,
    raw.cellNewVisitors,
    raw.cellNewCells,
  ].map((value) => (typeof value === "number" ? value : 0));
  const visitors = normalizeVisitors(raw.visitors);
  const attended = reported && raw.attended === true;
  const discipleshipAttended = reported && raw.discipleshipAttended === true;
  // D38: the dual reading — a zero row is not the same as an absent row.
  const noActivity =
    reported &&
    !attended &&
    !discipleshipAttended &&
    visitors.length === 0 &&
    counters.every((value) => value === 0);
  const offeringState: OfferingState =
    raw.reportId === null ? "NONE" : ((raw.offeringStatus ?? "NONE") as OfferingState);

  return {
    userId: raw.userId,
    fullName: raw.fullName,
    publicCode: raw.publicCode,
    level: raw.level,
    sponsorName: raw.sponsorName,
    sponsorCode: raw.sponsorCode,
    reported,
    noActivity,
    attended,
    discipleshipAttended,
    cellsTotal: counters[0],
    cellsHeld: counters[1],
    cellsNotHeld: counters[2],
    cellAttendees: counters[3],
    cellAbsentees: counters[4],
    cellNewVisitors: counters[5],
    cellNewCells: counters[6],
    visitors,
    note: raw.note,
    offeringState,
    amount: raw.amount,
    currency: raw.currency,
    method: raw.method,
    paidAt: raw.paidAt,
  };
}

/**
 * Totals derived from the SAME rows the table renders.
 *
 * A total that is computed by a second SQL statement while the table is
 * computed by the first is a total that will eventually disagree with the
 * table. Summing here — and in scaled cents — makes drift impossible and keeps
 * A14 (no float arithmetic on money) true for the report as well.
 */
export function summarizeSheet(rows: readonly ConsolidatedSheetRow[]): ConsolidatedSheetTotals {
  let reported = 0;
  let attended = 0;
  let offered = 0;
  let visitors = 0;
  const liveAmounts: bigint[] = [];
  const approvedAmounts: bigint[] = [];

  for (const row of rows) {
    if (row.reported) reported += 1;
    if (row.reported && row.attended) attended += 1;
    visitors += row.visitors.length;

    const live = row.offeringState === "PENDING" || row.offeringState === "APPROVED";
    if (!live) continue;
    offered += 1;
    if (row.amount !== null) {
      const cents = parseAmount(row.amount);
      liveAmounts.push(cents);
      if (row.offeringState === "APPROVED") approvedAmounts.push(cents);
    }
  }

  return {
    people: rows.length,
    reported,
    notReported: rows.length - reported,
    attended,
    offered,
    amountTotal: formatAmount(addAmounts(...liveAmounts)),
    amountApproved: formatAmount(addAmounts(...approvedAmounts)),
    visitors,
  };
}

// -----------------------------------------------------------------------------
// The shared row -> matrix shaper (screen / CSV / XLSX / print)
// -----------------------------------------------------------------------------

export const SHEET_HEADERS = [
  "Nivel",
  "Nombre",
  "Código",
  "Patrocinador",
  "Reporte",
  "Asistió",
  "Discipulado",
  "Células",
  "Realizadas",
  "No realizadas",
  "Asistentes",
  "Ausentes",
  "Visitantes nuevos",
  "Células nuevas",
  "Visitantes",
  "Nombres de visitantes",
  "Nota",
  "Ofrenda",
  "Monto",
  "Moneda",
  "Método",
  "Fecha de pago",
] as const;

/** Column widths (characters) for the XLSX sheet; same order as the headers. */
export const SHEET_COLUMN_WIDTHS = [
  6, 28, 12, 28, 14, 9, 12, 9, 11, 14, 11, 9, 16, 14, 10, 32, 32, 12, 10, 9, 14, 14,
] as const;

export const METHOD_LABELS: Record<string, string> = {
  TRANSFER: "Transferencia",
  MOBILE: "Pago móvil",
  ZELLE: "Zelle",
  CASH: "Efectivo",
  CRYPTO: "Cripto",
  OTHER: "Otro",
};

export const OFFERING_LABELS: Record<OfferingState, string> = {
  NONE: "Sin reporte",
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

export interface SheetMatrix {
  headers: readonly string[];
  rows: string[][];
}

/** `DD/MM/YYYY`, formatted on the server so SSR stays deterministic. */
export function dateLabel(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function reportLabel(row: ConsolidatedSheetRow): string {
  if (!row.reported) return "No reportó";
  return row.noActivity ? "Sin actividad" : "Reportó";
}

function flagCell(row: ConsolidatedSheetRow, value: boolean): string {
  if (!row.reported) return "—";
  return value ? "Sí" : "No";
}

function counterCell(row: ConsolidatedSheetRow, value: number): string {
  return row.reported ? String(value) : "—";
}

/**
 * The single definition of a sheet row, used by every surface. Adding a column
 * means adding a header and one cell here — never a second place where the
 * screen and the export can disagree.
 */
export function sheetMatrix(sheet: ConsolidatedSheet): SheetMatrix {
  return {
    headers: SHEET_HEADERS,
    rows: sheet.rows.map((row) => [
      String(row.level),
      row.fullName,
      row.publicCode,
      row.sponsorName ?? "—",
      reportLabel(row),
      flagCell(row, row.attended),
      flagCell(row, row.discipleshipAttended),
      counterCell(row, row.cellsTotal),
      counterCell(row, row.cellsHeld),
      counterCell(row, row.cellsNotHeld),
      counterCell(row, row.cellAttendees),
      counterCell(row, row.cellAbsentees),
      counterCell(row, row.cellNewVisitors),
      counterCell(row, row.cellNewCells),
      row.reported ? String(row.visitors.length) : "—",
      row.visitors.length > 0 ? row.visitors.join("; ") : "—",
      row.note ?? "—",
      OFFERING_LABELS[row.offeringState],
      row.amount ?? "—",
      row.currency ?? "—",
      row.method ? (METHOD_LABELS[row.method] ?? row.method) : "—",
      row.paidAt ? dateLabel(row.paidAt) : "—",
    ]),
  };
}

function csvField(value: string): string {
  // RFC 4180: a field containing a comma, a quote or a line break is quoted,
  // and its own quotes are doubled.
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * RFC 4180 CSV, CRLF line endings and a UTF-8 BOM: without the BOM Excel
 * misreads every accented name ("María" arrives as "MarÃ­a"). The BOM is part
 * of the contract, not an option — `format=csv` always means this string.
 */
export function sheetCsv(matrix: SheetMatrix): string {
  const lines = [matrix.headers as readonly string[], ...matrix.rows].map((cells) =>
    cells.map(csvField).join(","),
  );
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** `planilla-2026-W42.xlsx` / `.csv`; shared by the route and the page links. */
export function sheetFileName(periodKey: string, extension: "xlsx" | "csv"): string {
  return `planilla-${periodKey}.${extension}`;
}

/**
 * The currency to print next to the numeric totals: the single currency every
 * live amount shares, or "varias monedas" if an admin changed
 * `payments.currency` mid-cycle (§6). `null` when there is no money at all.
 */
export function sharedCurrencyLabel(sheet: ConsolidatedSheet): string | null {
  const currencies = new Set(
    sheet.rows
      .filter((row) => row.offeringState === "PENDING" || row.offeringState === "APPROVED")
      .map((row) => row.currency)
      .filter((value): value is string => value !== null),
  );
  if (currencies.size === 0) return null;
  if (currencies.size === 1) return [...currencies][0] ?? null;
  return "varias monedas";
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

const CYCLE_COLUMNS = Prisma.sql`id, period_key AS "periodKey", starts_at AS "startsAt",
       ends_at AS "endsAt", due_at AS "dueAt", status`;

export function createReportsService(
  db: ReportsDb,
  authz: ReportsAuthz,
  options: ReportsServiceOptions = {},
): ReportsService {
  const now = options.now ?? (() => new Date());

  const requireStaff = (actor: SessionActor): void => {
    if (!isStaffActor(actor)) {
      // D39: amounts are staff business. Refused before any read runs.
      throw new ForbiddenError("reports:read requires a staff actor");
    }
  };

  const cycleByPeriodKey = async (periodKey: string): Promise<CycleOption> => {
    const rows = await db.$queryRaw<CycleOption[]>`
      /* @reports:cycle-by-key */
      SELECT ${CYCLE_COLUMNS}
      FROM payment_cycles
      WHERE period_key = ${periodKey}
      LIMIT 1
    `;
    const cycle = rows[0];
    if (!cycle) throw new NotFoundError("No se encontró la semana indicada.");
    return cycle;
  };

  const currentCycle = async (): Promise<CycleOption> => {
    const at = now();
    // The cycle containing `now()` wins (upper bound exclusive, mirroring
    // D37's [starts_at, due_at) window); with none containing it, the newest
    // cycle already started is the best available sheet.
    const rows = await db.$queryRaw<CycleOption[]>`
      /* @reports:current-cycle */
      SELECT ${CYCLE_COLUMNS}
      FROM payment_cycles
      ORDER BY (starts_at <= ${at} AND ${at} < due_at) DESC, starts_at DESC
      LIMIT 1
    `;
    const cycle = rows[0];
    if (!cycle) throw new NotFoundError("Todavía no hay semanas registradas.");
    return cycle;
  };

  return {
    async listCycles(listOptions = {}) {
      const limit = clampLimit(listOptions.limit, DEFAULT_CYCLES_LISTED, MAX_CYCLES_LISTED);
      return db.$queryRaw<CycleOption[]>`
        /* @reports:list-cycles */
        SELECT ${CYCLE_COLUMNS}
        FROM payment_cycles
        ORDER BY starts_at DESC
        LIMIT ${limit}
      `;
    },

    async getConsolidatedSheet(actor, selector = {}) {
      requireStaff(actor);
      const cycle = selector.periodKey
        ? await cycleByPeriodKey(selector.periodKey)
        : await currentCycle();

      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const condition = scope.unrestricted ? Prisma.empty : Prisma.sql`AND ${scope.fragment}`;

      const raw = await db.$queryRaw<SheetRawRow[]>`
        /* @reports:consolidated-sheet */
        SELECT u.id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
               u.depth AS "level", s.full_name AS "sponsorName", s.public_code AS "sponsorCode",
               w.id AS "weeklyReportId",
               w.attended, w.discipleship_attended AS "discipleshipAttended",
               w.cells_total AS "cellsTotal", w.cells_held AS "cellsHeld", w.cells_not_held AS "cellsNotHeld",
               w.cell_attendees AS "cellAttendees", w.cell_absentees AS "cellAbsentees",
               w.cell_new_visitors AS "cellNewVisitors", w.cell_new_cells AS "cellNewCells",
               w.visitors, w.note,
               r.id AS "reportId", r.status::text AS "offeringStatus", r.amount::text AS amount,
               r.currency, r.method::text AS method, r.paid_at AS "paidAt"
        FROM users u
        LEFT JOIN users s ON s.id = u.sponsor_id
        LEFT JOIN weekly_reports w ON w.user_id = u.id AND w.cycle_id = ${cycle.id}::uuid
        LEFT JOIN LATERAL (
          -- One offering per person: the live report (PENDING/APPROVED) when it
          -- exists — at most one per uq_report_user_cycle (D4) — else the most
          -- recent REJECTED one, which is what the sheet must show as rejected.
          SELECT r.id, r.status, r.amount, r.currency, r.method, r.paid_at
          FROM payment_reports r
          WHERE r.user_id = u.id AND r.cycle_id = ${cycle.id}::uuid
          ORDER BY (r.status <> 'REJECTED') DESC, r.reported_at DESC
          LIMIT 1
        ) r ON true
        WHERE u.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM cycle_obligations o WHERE o.cycle_id = ${cycle.id}::uuid AND o.user_id = u.id)
            OR w.id IS NOT NULL
            OR r.id IS NOT NULL
          )
          ${condition}
        ORDER BY u.full_name
      `;

      const rows = raw.map(toConsolidatedRow);
      return { cycle, rows, totals: summarizeSheet(rows) };
    },
  };
}
