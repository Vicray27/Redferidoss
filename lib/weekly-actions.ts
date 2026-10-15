// =============================================================================
// lib/weekly-actions.ts — the Server Action behind the weekly report form in
// /portal/semana: the member records their own attendance and cell numbers
// once per cycle (the "Visión Celular" report, D38/D44).
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
    await weekly.saveReport(toActor(session), {
      attended: input.attended,
      discipleshipAttended: input.discipleshipAttended,
      ...input.counters,
      visitors: input.visitors,
      note: input.note ?? null,
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
