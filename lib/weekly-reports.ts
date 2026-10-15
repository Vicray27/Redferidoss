// =============================================================================
// lib/weekly-reports.ts — §8.4 + migration 0003: the self-service weekly report.
//
// "Visión Celular" in one row: whether the person attended, whether they went
// to discipleship, and the seven cell counters. One report per person per
// cycle (uq_weekly_reports_user_cycle) and it is an UPSERT while the cycle is
// still inside [starts_at, due_at) — a member can correct their own numbers
// during the week, and after due_at the report is frozen (D44). Because it is
// a single ON CONFLICT statement, two open tabs cannot produce two rows and no
// advisory lock is needed (same doctrine as D41).
//
// The A6 boundary case ("domingo 23:59") needs no timezone arithmetic here:
// the cycle rows were planned with payments.week_start_day in general.timezone
// (jobs/execute.ts), so "the cycle that contains now()" is already the right
// one at any instant.
//
// The downline read (a leader seeing their people's cell activity) reuses the
// SAME authorization scope as every §12 network read — `scopeFilter` is ANDed
// into the statement, so a MEMBER is capped at direct invitees (D40) with no
// code here choosing a depth.
// =============================================================================

import { Prisma } from "@prisma/client";

import type { SessionActor } from "./authz";
import { ConflictError, ValidationError } from "./errors";

/** Prisma-compatible raw database surface (a fake implements it in tests). */
export interface WeeklyReportsDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Authorization surface the downline read needs (lib/authz satisfies it). */
export interface WeeklyReportsAuthz {
  scopeFilter(actor: SessionActor, options?: { alias?: string }): Promise<{ fragment: Prisma.Sql; unrestricted: boolean }>;
}

export interface WeeklyReportInput {
  attended: boolean;
  discipleshipAttended: boolean;
  cellsTotal: number;
  cellsHeld: number;
  cellsNotHeld: number;
  cellAttendees: number;
  cellAbsentees: number;
  cellNewVisitors: number;
  cellNewCells: number;
  /** Still-unregistered visitors, by name (no identity to reference yet). */
  visitors: string[];
  note?: string | null;
}

export interface SavedWeeklyReport {
  id: string;
  cycleId: string;
  periodKey: string;
  updatedAt: Date;
}

export interface MyWeeklyReportRow {
  id: string;
  cycleId: string;
  periodKey: string;
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
  updatedAt: Date;
}

export interface DownlineWeeklyReportRow extends MyWeeklyReportRow {
  userId: string;
  fullName: string;
  publicCode: string;
}

export interface WeeklyReportsService {
  saveReport(actor: SessionActor, input: WeeklyReportInput): Promise<SavedWeeklyReport>;
  myReports(actor: SessionActor, options?: { limit?: number }): Promise<MyWeeklyReportRow[]>;
  /** The reports of the people inside the actor's authorization scope for a cycle. */
  downlineReports(actor: SessionActor, options?: { cycleId?: string; limit?: number }): Promise<DownlineWeeklyReportRow[]>;
}

export interface WeeklyReportsOptions {
  now?: () => Date;
}

export const MAX_WEEKLY_COUNTER = 9999;
export const MAX_VISITOR_NAMES = 50;
export const MAX_VISITOR_NAME_LENGTH = 120;
export const MAX_WEEKLY_NOTE_LENGTH = 2000;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

interface CycleRow {
  id: string;
  period_key: string;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_LIST_LIMIT);
}

/** Field-level validation shared by saveReport; exported for the form (WU7). */
export function validateWeeklyReportInput(input: WeeklyReportInput): WeeklyReportInput {
  const bounded = (name: keyof WeeklyReportInput): number => {
    const value = input[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_WEEKLY_COUNTER) {
      throw new ValidationError(`El contador "${name}" debe ser un número entero entre 0 y ${MAX_WEEKLY_COUNTER}.`, {
        [name]: `Usa un número entero entre 0 y ${MAX_WEEKLY_COUNTER}.`,
      });
    }
    return value;
  };

  if (typeof input.attended !== "boolean" || typeof input.discipleshipAttended !== "boolean") {
    throw new ValidationError("Marca si asististe a la reunión y a discipulado.", {
      attended: "El valor debe ser verdadero o falso.",
    });
  }

  for (const name of ["cellsTotal", "cellsHeld", "cellsNotHeld", "cellAttendees", "cellAbsentees", "cellNewVisitors", "cellNewCells"] as const) {
    bounded(name);
  }

  if (!Array.isArray(input.visitors) || input.visitors.length > MAX_VISITOR_NAMES) {
    throw new ValidationError(`Puedes registrar hasta ${MAX_VISITOR_NAMES} visitantes.`, {
      visitors: `Usa una lista de hasta ${MAX_VISITOR_NAMES} nombres.`,
    });
  }
  const visitors = input.visitors.map((name) => {
    if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_VISITOR_NAME_LENGTH) {
      throw new ValidationError("Cada visitante necesita un nombre.", {
        visitors: `Cada nombre debe tener entre 1 y ${MAX_VISITOR_NAME_LENGTH} caracteres.`,
      });
    }
    return name.trim();
  });

  const note = input.note?.trim() ? input.note.trim() : null;
  if (note !== null && note.length > MAX_WEEKLY_NOTE_LENGTH) {
    throw new ValidationError(`La nota no puede superar ${MAX_WEEKLY_NOTE_LENGTH} caracteres.`, {
      note: `Acorta la nota a ${MAX_WEEKLY_NOTE_LENGTH} caracteres.`,
    });
  }

  return { ...input, visitors, note };
}

export function createWeeklyReportsService(
  db: WeeklyReportsDb,
  authz: WeeklyReportsAuthz,
  options: WeeklyReportsOptions = {},
): WeeklyReportsService {
  const now = options.now ?? (() => new Date());

  const reportableCycle = async (): Promise<CycleRow> => {
    const cycles = await db.$queryRaw<CycleRow[]>`
      /* @weekly:cycle-window */
      SELECT id, period_key FROM payment_cycles
      WHERE starts_at <= ${now()} AND ${now()} < due_at
      ORDER BY starts_at DESC
      LIMIT 1
    `;
    const cycle = cycles[0];
    if (!cycle) {
      throw new ConflictError("No hay una semana abierta para reportar.", "NO_REPORT_WINDOW");
    }
    return cycle;
  };

  return {
    async saveReport(actor, rawInput) {
      const input = validateWeeklyReportInput(rawInput);
      const cycle = await reportableCycle();

      const saved = await db.$queryRaw<Array<{ id: string; updated_at: Date }>>`
        /* @weekly:upsert */
        INSERT INTO weekly_reports
          (user_id, cycle_id, attended, discipleship_attended, cells_total, cells_held, cells_not_held,
           cell_attendees, cell_absentees, cell_new_visitors, cell_new_cells, visitors, note)
        VALUES
          (${actor.userId}::uuid, ${cycle.id}::uuid, ${input.attended}, ${input.discipleshipAttended},
           ${input.cellsTotal}, ${input.cellsHeld}, ${input.cellsNotHeld}, ${input.cellAttendees},
           ${input.cellAbsentees}, ${input.cellNewVisitors}, ${input.cellNewCells},
           ${JSON.stringify(input.visitors)}::jsonb, ${input.note})
        ON CONFLICT (user_id, cycle_id) DO UPDATE SET
          attended = EXCLUDED.attended,
          discipleship_attended = EXCLUDED.discipleship_attended,
          cells_total = EXCLUDED.cells_total,
          cells_held = EXCLUDED.cells_held,
          cells_not_held = EXCLUDED.cells_not_held,
          cell_attendees = EXCLUDED.cell_attendees,
          cell_absentees = EXCLUDED.cell_absentees,
          cell_new_visitors = EXCLUDED.cell_new_visitors,
          cell_new_cells = EXCLUDED.cell_new_cells,
          visitors = EXCLUDED.visitors,
          note = EXCLUDED.note,
          updated_at = now()
        RETURNING id, updated_at
      `;
      const row = saved[0];
      if (!row) {
        throw new Error("weekly_reports upsert returned no row");
      }
      return { id: row.id, cycleId: cycle.id, periodKey: cycle.period_key, updatedAt: row.updated_at };
    },

    async myReports(actor, listOptions = {}) {
      const limit = clampLimit(listOptions.limit);
      return db.$queryRaw<MyWeeklyReportRow[]>`
        /* @weekly:my-reports */
        SELECT w.id, w.cycle_id AS "cycleId", c.period_key AS "periodKey",
               w.attended, w.discipleship_attended AS "discipleshipAttended",
               w.cells_total AS "cellsTotal", w.cells_held AS "cellsHeld", w.cells_not_held AS "cellsNotHeld",
               w.cell_attendees AS "cellAttendees", w.cell_absentees AS "cellAbsentees",
               w.cell_new_visitors AS "cellNewVisitors", w.cell_new_cells AS "cellNewCells",
               w.visitors, w.note, w.updated_at AS "updatedAt"
        FROM weekly_reports w
        JOIN payment_cycles c ON c.id = w.cycle_id
        WHERE w.user_id = ${actor.userId}::uuid
        ORDER BY c.starts_at DESC
        LIMIT ${limit}
      `;
    },

    async downlineReports(actor, listOptions = {}) {
      const limit = clampLimit(listOptions.limit);
      const scope = await authz.scopeFilter(actor, { alias: "u" });
      const condition = scope.unrestricted ? Prisma.empty : Prisma.sql`AND ${scope.fragment}`;
      const cycle = listOptions.cycleId ? null : await reportableCycle();
      const cycleId = listOptions.cycleId ?? cycle?.id ?? null;

      return db.$queryRaw<DownlineWeeklyReportRow[]>`
        /* @weekly:downline-reports */
        SELECT w.id, w.user_id AS "userId", u.full_name AS "fullName", u.public_code AS "publicCode",
               w.cycle_id AS "cycleId", c.period_key AS "periodKey",
               w.attended, w.discipleship_attended AS "discipleshipAttended",
               w.cells_total AS "cellsTotal", w.cells_held AS "cellsHeld", w.cells_not_held AS "cellsNotHeld",
               w.cell_attendees AS "cellAttendees", w.cell_absentees AS "cellAbsentees",
               w.cell_new_visitors AS "cellNewVisitors", w.cell_new_cells AS "cellNewCells",
               w.visitors, w.note, w.updated_at AS "updatedAt"
        FROM weekly_reports w
        JOIN users u ON u.id = w.user_id
        JOIN payment_cycles c ON c.id = w.cycle_id
        WHERE w.cycle_id = ${cycleId}::uuid
          AND u.deleted_at IS NULL
          AND u.id <> ${actor.userId}::uuid
          ${condition}
        ORDER BY u.full_name
        LIMIT ${limit}
      `;
    },
  };
}
