// =============================================================================
// lib/weekly-actions.ts — the Server Action behind the weekly report form in
// /portal/semana: the member records their own attendance and — only for the
// pastor/member root — the cell numbers once per cycle (the "Visión Celular"
// report, D38/D44).
//
// Same shape as lib/payments-actions.ts: session first, then the service, and
// AppError becomes a message for the form. The upsert semantics (D44) and all
// validation bounds stay in lib/weekly-reports.ts.
// =============================================================================

"use server";

import { revalidatePath } from "next/cache";

import { getSession } from "./auth/require";
import { authorization, toActor } from "./authz";
import { prisma } from "./db";
import { AppError } from "./errors";
import { createWeeklyReportsService } from "./weekly-reports";

export interface WeeklyActionResult {
  ok: boolean;
  message?: string;
}

/**
 * The pastor is the single member-tree root (0007_system_root), selected with
 * the same query the page uses. Duplicated on purpose: the page controls what
 * is rendered, this controls what is persisted.
 */
async function isMemberRoot(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE sponsor_id IS NULL AND role <> 'ROOT' AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0]?.id === userId;
}

export async function saveWeeklyReportAction(input: {
  attended: boolean;
  discipleshipAttended: boolean;
  counters: {
    cellsTotal: number;
    cellsHeld: number;
    cellsNotHeld: number;
    cellAttendees: number;
    cellAbsentees: number;
    cellNewVisitors: number;
    cellNewCells: number;
  };
  /** Unregistered visitors, already split into names by the client. */
  visitors: string[];
  note?: string | null;
}): Promise<WeeklyActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, message: "Debes iniciar sesión para continuar." };

  try {
    const weekly = createWeeklyReportsService(prisma, authorization);

    // The form is not the security boundary: a non-pastor may still post a
    // forged cell payload, so it is discarded here and only attendance is kept.
    const isPastor = await isMemberRoot(session.userId);
    const cellPayload = isPastor
      ? {
          ...input.counters,
          visitors: input.visitors,
          note: input.note ?? null,
        }
      : {
          cellsTotal: 0,
          cellsHeld: 0,
          cellsNotHeld: 0,
          cellAttendees: 0,
          cellAbsentees: 0,
          cellNewVisitors: 0,
          cellNewCells: 0,
          visitors: [] as string[],
          note: null,
        };

    await weekly.saveReport(toActor(session), {
      attended: input.attended,
      discipleshipAttended: input.discipleshipAttended,
      ...cellPayload,
    });

    revalidatePath("/portal/semana");
    return { ok: true };
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
