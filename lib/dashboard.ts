// =============================================================================
// lib/dashboard.ts — §8.5: the read model behind the Persona #1's landing.
//
// The client requirement is explicit: "la raíz ve siempre y en detalle todos
// los reportes de pago: monto, fecha, quién y cuándo". This module answers the
// aggregate half of that sentence — the eight KPI cards, the five chart series
// and the weekly compliance matrix — while the master payments listing lives in
// lib/payments-admin.ts and the review rules stay in lib/payments.ts.
//
// WHO MAY READ
// ------------
// Staff only (ROOT/ADMIN), enforced HERE with the same doctrine every service
// in this codebase follows (D39): the guard runs before the first statement, so
// a MEMBER gets a 403 without SQL ever executing. These reads are the whole
// network's money: there is no member-shaped projection of them to produce.
//
// MONEY
// -----
// Every aggregate crosses the boundary as a DECIMAL string and is summed or
// divided in scaled BigInt cents (lib/money.ts, A14). The one number that is
// NOT money — the compliance rate — is a display ratio (approved/obligations)
// and crosses as a plain number, which is stated in D50 so nobody starts
// treating a percentage as an amount.
//
// CHART WINDOWS (D49)
// -----------------------
// `weeks` ∈ {12, 26, 52} of PAYMENT CYCLES, not calendar weeks: the cycle is
// the unit every figure in this app is filed under, and the selected cycle is
// always the LAST point of the window. The heatmap and the compliance matrix
// reuse the same anchor so the screen never mixes two different windows.
// =============================================================================

import { Prisma } from "@prisma/client";

import { ForbiddenError, isStaffActor, type SessionActor } from "./authz";
import { CHART_WINDOWS } from "./charts";
import { NotFoundError } from "./errors";
import { addAmounts, formatAmount, parseAmount } from "./money";
import type { CycleOption } from "./reports";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface DashboardDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Authorization surface (lib/authz satisfies it). */
export interface DashboardAuthz {
  scopeFilter(actor: SessionActor, options?: { alias?: string }): Promise<{ fragment: Prisma.Sql; unrestricted: boolean }>;
}

export interface DashboardServiceOptions {
  now?: () => Date;
}

/** The five chart windows §8.5 offers — one definition, in lib/charts (D49). */
export const DASHBOARD_WINDOWS = CHART_WINDOWS;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

/** The compliance matrix is bounded by this many people (D54). */
export const COMPLIANCE_MAX_USERS = 500;
/** The compliance window choices; wider than 26 stops being readable (D54). */
export const COMPLIANCE_WINDOWS = [4, 12, 26] as const;
export type ComplianceWindow = (typeof COMPLIANCE_WINDOWS)[number];
export const DEFAULT_COMPLIANCE_WINDOW: ComplianceWindow = 12;

export function resolveWindow<T extends number>(
  raw: unknown,
  supported: readonly T[],
  fallback: T,
): T {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return (supported as readonly number[]).includes(value) ? (value as T) : fallback;
}

// -----------------------------------------------------------------------------
// KPI cards
// -----------------------------------------------------------------------------

export interface DashboardKpis {
  /** DECIMAL string: sum of APPROVED amounts in the cycle (A14). */
  collectedTotal: string;
  /** Every report of the cycle, any status ("cuántos reportaron"). */
  reportsCount: number;
  /** collectedTotal / approved reports; "0.00" when nobody was approved yet. */
  averageTicket: string;
  /** approved / obligations, 0..1 display ratio — NOT money (D50). */
  complianceRate: number;
  pendingCount: number;
  /** Obligations the close job marked MISSED. */
  missedCount: number;
  /** Users created inside the selected cycle's window. */
  newUsersCount: number;
  /** Live users, period-independent (D50). */
  networkSize: number;
}

// -----------------------------------------------------------------------------
// Chart series
// -----------------------------------------------------------------------------

export interface WeeklySeriesPoint {
  periodKey: string;
  startsAt: Date;
  approvedTotal: string;
  reportsCount: number;
  obligationsCount: number;
}

export interface LevelContribution {
  level: number;
  total: string;
  reports: number;
}

export interface ContributorRow {
  userId: string;
  fullName: string;
  publicCode: string;
  level: number;
  total: string;
  reports: number;
}

export interface SponsorRow {
  userId: string;
  fullName: string;
  publicCode: string;
  /** Approved amount contributed by the sponsor's downline in the period. */
  total: string;
  reports: number;
}

export interface HeatmapCell {
  periodKey: string;
  level: number;
  approved: number;
  obligations: number;
}

export interface ComplianceHeatmap {
  /** Chronological period keys of the window (left to right). */
  periodKeys: string[];
  /** Tree levels present in the window, ascending. */
  levels: number[];
  cells: HeatmapCell[];
}

export interface DashboardOverview {
  cycle: CycleOption;
  weeks: DashboardWindow;
  kpis: DashboardKpis;
  /** Chronological: oldest point first. */
  weeklySeries: WeeklySeriesPoint[];
  levelContribution: LevelContribution[];
  topContributors: ContributorRow[];
  topSponsors: SponsorRow[];
  heatmap: ComplianceHeatmap;
}

// -----------------------------------------------------------------------------
// Compliance matrix
// -----------------------------------------------------------------------------

export type ComplianceState = "approved" | "pending" | "missed" | "exempt";

export interface ComplianceCell {
  periodKey: string;
  state: ComplianceState;
}

export interface ComplianceUserRow {
  userId: string;
  fullName: string;
  publicCode: string;
  level: number;
  cells: ComplianceCell[];
}

export interface ComplianceMatrix {
  cycle: CycleOption;
  weeks: ComplianceWindow;
  /** Chronological period keys of the window (columns). */
  periodKeys: string[];
  rows: ComplianceUserRow[];
  /** True when more people matched than `COMPLIANCE_MAX_USERS`. */
  truncated: boolean;
}

// -----------------------------------------------------------------------------
// Filter support reads
// -----------------------------------------------------------------------------

export interface UserOption {
  id: string;
  fullName: string;
  publicCode: string;
  email: string | null;
}

export interface DashboardCustomField {
  id: string;
  code: string;
  label: string;
  fieldType: string;
}

export interface MethodOption {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

export interface DashboardService {
  /** The eight KPI cards, the five chart series and the heatmap of one cycle. */
  getOverview(actor: SessionActor, options?: { periodKey?: string; weeks?: number }): Promise<DashboardOverview>;
  /** The user × week compliance matrix (D54). */
  getCompliance(actor: SessionActor, options?: { periodKey?: string; weeks?: number }): Promise<ComplianceMatrix>;
  /** Autocomplete for filter #4: name, email or public code. Staff-only. */
  searchUsers(actor: SessionActor, query: string, options?: { limit?: number }): Promise<UserOption[]>;
  /** Resolve one user for the filter's initial label; null when it is gone. */
  userOption(actor: SessionActor, userId: string): Promise<UserOption | null>;
  /** PAYMENT_REPORT custom fields flagged for the dashboard (filter #12). */
  listDashboardCustomFields(actor: SessionActor): Promise<DashboardCustomField[]>;
  /** Payment methods for filter #7; inactive ones stay listed for history. */
  listPaymentMethods(actor: SessionActor): Promise<MethodOption[]>;
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;

interface KpiRawRow {
  approvedTotal: string;
  reportsCount: number;
  approvedCount: number;
  pendingCount: number;
  obligationsCount: number;
  missedCount: number;
  newUsersCount: number;
  networkSize: number;
}

interface HeatmapRawRow {
  periodKey: string;
  level: number;
  approved: number;
  obligations: number;
}

interface ComplianceRawRow {
  cycleId: string;
  periodKey: string;
  startsAt: Date;
  userId: string;
  fullName: string;
  publicCode: string;
  level: number;
  obligationId: string | null;
  obligationStatus: string | null;
  approved: boolean | null;
  pending: boolean | null;
  rejected: boolean | null;
}

/**
 * One cell of the compliance matrix (D54):
 *   approved -> any APPROVED report in the cycle (green),
 *   pending  -> a PENDING report, or an obligation that still owes (yellow),
 *   missed   -> the only trace is a REJECTED report, or the obligation is
 *               MISSED (red),
 *   exempt   -> the obligation is EXEMPT, or there is none (gray).
 */
export function complianceState(row: {
  obligationId: string | null;
  obligationStatus: string | null;
  approved: boolean | null;
  pending: boolean | null;
  rejected: boolean | null;
}): ComplianceState {
  if (row.approved === true) return "approved";
  if (row.pending === true) return "pending";
  if (row.rejected === true) return "missed";
  if (row.obligationStatus === "MISSED") return "missed";
  if (row.obligationStatus === "EXEMPT") return "exempt";
  if (row.obligationId !== null) return "pending";
  return "exempt";
}

/**
 * The Spanish labels of the matrix (D54). One map so the legend, the cell
 * titles and every drill-down share words: a person reading the legend and a
 * person hovering a cell must not see two names for the same state.
 */
export const COMPLIANCE_STATE_LABELS: Record<ComplianceState, string> = {
  approved: "Aprobado",
  pending: "Pendiente por reportar",
  missed: "Incumplido",
  exempt: "Exento / sin obligación",
};

export function createDashboardService(
  db: DashboardDb,
  authz: DashboardAuthz,
  options: DashboardServiceOptions = {},
): DashboardService {
  const now = options.now ?? (() => new Date());

  const requireStaff = (actor: SessionActor): void => {
    if (!isStaffActor(actor)) {
      // D39/D50: the whole network's money is staff business. No SQL on refusal.
      throw new ForbiddenError("dashboard:read requires a staff actor");
    }
  };

  const cycleByPeriodKey = async (periodKey: string): Promise<CycleOption> => {
    const rows = await db.$queryRaw<CycleOption[]>`
      /* @dash:cycle-by-key */
      SELECT id, period_key AS "periodKey", starts_at AS "startsAt",
             ends_at AS "endsAt", due_at AS "dueAt", status
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
    // D37's [starts_at, due_at) window); with none containing it — possible
    // only before the first cycle starts, because consecutive windows are
    // contiguous — the newest cycle that already started is the best
    // available sheet, and only if none started does the newest planned
    // window win.
    const rows = await db.$queryRaw<CycleOption[]>`
      /* @dash:current-cycle */
      SELECT id, period_key AS "periodKey", starts_at AS "startsAt",
             ends_at AS "endsAt", due_at AS "dueAt", status
      FROM payment_cycles
      ORDER BY (starts_at <= ${at} AND ${at} < due_at) DESC, (starts_at <= ${at}) DESC, starts_at DESC
      LIMIT 1
    `;
    const cycle = rows[0];
    if (!cycle) throw new NotFoundError("Todavía no hay semanas registradas.");
    return cycle;
  };

  return {
    async getOverview(actor, overviewOptions = {}) {
      requireStaff(actor);
      const weeks = resolveWindow(overviewOptions.weeks, DASHBOARD_WINDOWS, 12);
      const cycle = overviewOptions.periodKey
        ? await cycleByPeriodKey(overviewOptions.periodKey)
        : await currentCycle();

      const [kpiRows, series, levels, contributors, sponsors, heatmapRaw] = await Promise.all([
        db.$queryRaw<KpiRawRow[]>`
          /* @dash:kpis */
          SELECT
            (SELECT COALESCE(SUM(r.amount), 0)::text FROM payment_reports r
              WHERE r.cycle_id = ${cycle.id}::uuid AND r.status = 'APPROVED') AS "approvedTotal",
            (SELECT COUNT(*)::int FROM payment_reports r
              WHERE r.cycle_id = ${cycle.id}::uuid) AS "reportsCount",
            (SELECT COUNT(*)::int FROM payment_reports r
              WHERE r.cycle_id = ${cycle.id}::uuid AND r.status = 'APPROVED') AS "approvedCount",
            (SELECT COUNT(*)::int FROM payment_reports r
              WHERE r.cycle_id = ${cycle.id}::uuid AND r.status = 'PENDING') AS "pendingCount",
            (SELECT COUNT(*)::int FROM cycle_obligations o
              WHERE o.cycle_id = ${cycle.id}::uuid) AS "obligationsCount",
            (SELECT COUNT(*)::int FROM cycle_obligations o
              WHERE o.cycle_id = ${cycle.id}::uuid AND o.status = 'MISSED') AS "missedCount",
            (SELECT COUNT(*)::int FROM users u
              WHERE u.deleted_at IS NULL
                AND u.created_at >= ${cycle.startsAt} AND u.created_at < ${cycle.endsAt}) AS "newUsersCount",
            (SELECT COUNT(*)::int FROM users u WHERE u.deleted_at IS NULL) AS "networkSize"
        `,
        db.$queryRaw<WeeklySeriesPoint[]>`
          /* @dash:weekly-series */
          -- Money comes from mv_payment_weekly (§14): the MV folds
          -- payment_reports into (cycle, level, method, status) buckets on the
          -- 5-minute refresh + on approval, so this chart stops scanning the
          -- report table as it grows to 1M rows. A cycle with no reports yet
          -- keeps returning zeros through COALESCE, exactly as before.
          SELECT c.period_key AS "periodKey", c.starts_at AS "startsAt",
                 COALESCE((SELECT SUM(m.total_amount) FROM mv_payment_weekly m
                   WHERE m.cycle_id = c.id AND m.status = 'APPROVED'), 0)::text AS "approvedTotal",
                 COALESCE((SELECT SUM(m."count") FROM mv_payment_weekly m
                   WHERE m.cycle_id = c.id), 0)::int AS "reportsCount",
                 (SELECT COUNT(*)::int FROM cycle_obligations o
                   WHERE o.cycle_id = c.id) AS "obligationsCount"
          FROM payment_cycles c
          WHERE c.starts_at <= ${cycle.startsAt}
          ORDER BY c.starts_at DESC
          LIMIT ${weeks}
        `,
        db.$queryRaw<LevelContribution[]>`
          /* @dash:level-contribution */
          -- Same MV: the approved money per tree level of the selected cycle.
          -- The level is the depth captured at refresh time, which is the
          -- users.depth the live query read before (§14, D68).
          SELECT m.level AS level, COALESCE(SUM(m.total_amount), 0)::text AS total,
                 COALESCE(SUM(m."count"), 0)::int AS reports
          FROM mv_payment_weekly m
          WHERE m.cycle_id = ${cycle.id}::uuid AND m.status = 'APPROVED'
          GROUP BY m.level
          ORDER BY m.level
        `,
        db.$queryRaw<ContributorRow[]>`
          /* @dash:top-contributors */
          SELECT u.id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
                 u.depth AS level, SUM(r.amount)::text AS total, COUNT(*)::int AS reports
          FROM payment_reports r
          JOIN users u ON u.id = r.user_id
          WHERE r.cycle_id = ${cycle.id}::uuid AND r.status = 'APPROVED'
          GROUP BY u.id, u.full_name, u.public_code, u.depth
          ORDER BY SUM(r.amount) DESC, u.full_name ASC
          LIMIT 10
        `,
        db.$queryRaw<SponsorRow[]>`
          /* @dash:top-sponsors */
          -- A sponsor's "red" is their strict downline (the person excluded):
          -- this is the chart of which leader's network brought the money.
          SELECT s.id AS "userId", s.full_name AS "fullName", s.public_code AS "publicCode",
                 SUM(r.amount)::text AS total, COUNT(*)::int AS reports
          FROM users s
          JOIN users u ON u.path <@ s.path AND u.path <> s.path AND u.deleted_at IS NULL
          JOIN payment_reports r ON r.user_id = u.id
            AND r.cycle_id = ${cycle.id}::uuid AND r.status = 'APPROVED'
          WHERE s.deleted_at IS NULL
          GROUP BY s.id, s.full_name, s.public_code
          ORDER BY SUM(r.amount) DESC, s.full_name ASC
          LIMIT 10
        `,
        db.$queryRaw<HeatmapRawRow[]>`
          /* @dash:heatmap */
          WITH window_cycles AS (
            SELECT id, period_key, starts_at
            FROM payment_cycles
            WHERE starts_at <= ${cycle.startsAt}
            ORDER BY starts_at DESC
            LIMIT ${weeks}
          )
          SELECT wc.period_key AS "periodKey", u.depth AS level,
                 COUNT(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM payment_reports r
                   WHERE r.cycle_id = wc.id AND r.user_id = o.user_id AND r.status = 'APPROVED'
                 ))::int AS approved,
                 COUNT(*)::int AS obligations
          FROM window_cycles wc
          JOIN cycle_obligations o ON o.cycle_id = wc.id
          JOIN users u ON u.id = o.user_id
          WHERE u.deleted_at IS NULL
          GROUP BY wc.period_key, u.depth
          ORDER BY u.depth, wc.period_key
        `,
      ]);

      const kpiRaw = kpiRows[0];
      if (!kpiRaw) throw new Error("dashboard KPI query returned no row");

      // Chronological for a left-to-right chart; the SQL walked backwards so
      // the LIMIT keeps the newest cycles of the window.
      const weeklySeries = [...series].reverse();

      const levelsPresent = [...new Set(heatmapRaw.map((cell) => cell.level))].sort((a, b) => a - b);

      return {
        cycle,
        weeks,
        kpis: {
          collectedTotal: formatAmount(parseAmount(kpiRaw.approvedTotal)),
          reportsCount: Number(kpiRaw.reportsCount),
          // BigInt cents division: the ticket is exact to the cent, truncated
          // toward zero — a display average never invents a fraction of a cent.
          averageTicket:
            kpiRaw.approvedCount > 0
              ? formatAmount(parseAmount(kpiRaw.approvedTotal) / BigInt(kpiRaw.approvedCount))
              : "0.00",
          complianceRate:
            kpiRaw.obligationsCount > 0 ? kpiRaw.approvedCount / kpiRaw.obligationsCount : 0,
          pendingCount: Number(kpiRaw.pendingCount),
          missedCount: Number(kpiRaw.missedCount),
          newUsersCount: Number(kpiRaw.newUsersCount),
          networkSize: Number(kpiRaw.networkSize),
        },
        weeklySeries,
        levelContribution: levels,
        topContributors: contributors,
        topSponsors: sponsors,
        heatmap: {
          periodKeys: weeklySeries.map((point) => point.periodKey),
          levels: levelsPresent,
          cells: heatmapRaw,
        },
      };
    },

    async getCompliance(actor, complianceOptions = {}) {
      requireStaff(actor);
      const weeks = resolveWindow(complianceOptions.weeks, COMPLIANCE_WINDOWS, DEFAULT_COMPLIANCE_WINDOW);
      const cycle = complianceOptions.periodKey
        ? await cycleByPeriodKey(complianceOptions.periodKey)
        : await currentCycle();

      // cap + 1 candidates: the extra one is how the service KNOWS the matrix
      // was cut, instead of silently rendering a half network as the truth.
      const cap = COMPLIANCE_MAX_USERS;
      const raw = await db.$queryRaw<ComplianceRawRow[]>`
        /* @dash:compliance */
        WITH window_cycles AS (
          SELECT id, period_key, starts_at
          FROM payment_cycles
          WHERE starts_at <= ${cycle.startsAt}
          ORDER BY starts_at DESC
          LIMIT ${weeks}
        ),
        candidates AS (
          SELECT u.id, u.full_name, u.public_code, u.depth
          FROM users u
          WHERE u.deleted_at IS NULL AND (
            EXISTS (SELECT 1 FROM cycle_obligations o
              JOIN window_cycles wc ON wc.id = o.cycle_id WHERE o.user_id = u.id)
            OR EXISTS (SELECT 1 FROM payment_reports r
              JOIN window_cycles wc ON wc.id = r.cycle_id WHERE r.user_id = u.id)
          )
          ORDER BY u.full_name, u.id
          LIMIT ${cap + 1}
        )
        SELECT c.id AS "cycleId", c.period_key AS "periodKey", c.starts_at AS "startsAt",
               u.id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
               u.depth AS level,
               o.id AS "obligationId", o.status AS "obligationStatus",
               rep.approved, rep.pending, rep.rejected
        FROM candidates u
        CROSS JOIN window_cycles c
        LEFT JOIN cycle_obligations o ON o.cycle_id = c.id AND o.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT bool_or(r.status = 'APPROVED') AS approved,
                 bool_or(r.status = 'PENDING') AS pending,
                 bool_or(r.status = 'REJECTED') AS rejected
          FROM payment_reports r
          WHERE r.cycle_id = c.id AND r.user_id = u.id
        ) rep ON true
        WHERE o.id IS NOT NULL OR rep.approved OR rep.pending OR rep.rejected
        ORDER BY u.full_name, u.id, c.starts_at
      `;

      // The window columns come from the cycles themselves so a gap in the
      // matrix (a cycle with no candidate rows) still renders its column.
      const windowKeys = [...new Set(raw.map((row) => row.periodKey))].sort((a, b) =>
        a.localeCompare(b),
      );

      const byUser = new Map<string, ComplianceUserRow>();
      const cellsByUser = new Map<string, Map<string, ComplianceState>>();
      for (const row of raw) {
        let userRow = byUser.get(row.userId);
        if (!userRow) {
          userRow = {
            userId: row.userId,
            fullName: row.fullName,
            publicCode: row.publicCode,
            level: row.level,
            cells: [],
          };
          byUser.set(row.userId, userRow);
          cellsByUser.set(row.userId, new Map());
        }
        cellsByUser.get(row.userId)?.set(row.periodKey, complianceState(row));
      }

      const allUsers = [...byUser.values()];
      const truncated = allUsers.length > cap;
      const users = truncated ? allUsers.slice(0, cap) : allUsers;

      return {
        cycle,
        weeks,
        periodKeys: windowKeys,
        rows: users.map((userRow) => ({
          ...userRow,
          cells: windowKeys.map((periodKey) => ({
            periodKey,
            state: cellsByUser.get(userRow.userId)?.get(periodKey) ?? "exempt",
          })),
        })),
        truncated,
      };
    },

    async searchUsers(actor, query, searchOptions = {}) {
      requireStaff(actor);
      const q = query.trim();
      // Staff-only reads still short-circuit on an empty term: a keystroke-by-
      // keystroke autocomplete must not become a query storm (network/search
      // doctrine).
      if (q === "") return [];
      const limit = Math.min(
        Math.max(1, Math.trunc(searchOptions.limit ?? DEFAULT_SEARCH_LIMIT) || DEFAULT_SEARCH_LIMIT),
        MAX_SEARCH_LIMIT,
      );

      return db.$queryRaw<UserOption[]>`
        /* @dash:search-users */
        SELECT u.id, u.full_name AS "fullName", u.public_code AS "publicCode",
               u.email::text AS email
        FROM users u
        WHERE u.deleted_at IS NULL
          AND (u.full_name ILIKE '%' || ${q} || '%'
            OR u.email::text ILIKE '%' || ${q} || '%'
            OR u.public_code = upper(${q}))
        ORDER BY u.full_name
        LIMIT ${limit}
      `;
    },

    async userOption(actor, userId) {
      requireStaff(actor);
      const rows = await db.$queryRaw<UserOption[]>`
        /* @dash:user-option */
        SELECT u.id, u.full_name AS "fullName", u.public_code AS "publicCode",
               u.email::text AS email
        FROM users u
        WHERE u.id = ${userId}::uuid AND u.deleted_at IS NULL
        LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async listDashboardCustomFields(actor) {
      requireStaff(actor);
      return db.$queryRaw<DashboardCustomField[]>`
        /* @dash:custom-fields */
        SELECT id, code, label, type AS "fieldType"
        FROM custom_fields
        WHERE entity = 'PAYMENT_REPORT' AND show_in_dashboard AND is_active
        ORDER BY sort_order, label
      `;
    },

    async listPaymentMethods(actor) {
      requireStaff(actor);
      // Inactive methods stay listed: the filter is a HISTORICAL question and
      // a method that was turned off still explains last month's rows.
      return db.$queryRaw<MethodOption[]>`
        /* @dash:payment-methods */
        SELECT id, code, label, is_active AS "isActive"
        FROM payment_methods
        ORDER BY is_active DESC, sort_order, label
      `;
    },
  };
}

/** Sum helper kept next to the aggregations so tests can pin exact-cents math. */
export function sumDecimals(values: readonly string[]): string {
  return formatAmount(addAmounts(...values.map((value) => parseAmount(value))));
}
