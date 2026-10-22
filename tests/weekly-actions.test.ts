// =============================================================================
// tests/weekly-actions.test.ts — the Server Action is the boundary that decides
// who may persist Visión Celular counters.
//
// The page hides the counters from ordinary members, but a forged POST can still
// carry them. These tests prove the action discards that payload for everyone
// except the single member-tree root, before the service sees it.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ getSession: vi.fn() }));
const cacheMock = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const weeklyMock = vi.hoisted(() => ({ createWeeklyReportsService: vi.fn() }));
const dbMock = vi.hoisted(() => ({ prisma: { $queryRaw: vi.fn() } }));

vi.mock("@/lib/auth/require", () => sessionMock);
vi.mock("next/cache", () => cacheMock);
vi.mock("@/lib/weekly-reports", () => weeklyMock);
vi.mock("@/lib/db", () => dbMock);

import type { SessionPayload } from "@/lib/auth/session";
import { saveWeeklyReportAction } from "../lib/weekly-actions";

const MEMBER = {
  userId: "member-1",
  role: "MEMBER",
  publicCode: "MEM001",
  fullName: "Ana",
} as SessionPayload;

const PASTOR = {
  userId: "pastor-1",
  role: "ADMIN",
  publicCode: "PAS001",
  fullName: "Pastor",
} as SessionPayload;

const FORGED_COUNTERS = {
  cellsTotal: 9,
  cellsHeld: 8,
  cellsNotHeld: 1,
  cellAttendees: 50,
  cellAbsentees: 2,
  cellNewVisitors: 7,
  cellNewCells: 1,
};

const INPUT = {
  attended: true,
  discipleshipAttended: false,
  counters: FORGED_COUNTERS,
  visitors: ["Visitante"],
  note: "Nota de células",
};

function fakeWeeklyService() {
  const saveReport = vi.fn().mockResolvedValue({ id: "weekly-1" });
  weeklyMock.createWeeklyReportsService.mockReturnValue({ saveReport } as never);
  return saveReport;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.prisma.$queryRaw.mockResolvedValue([{ id: PASTOR.userId }]);
});

describe("saveWeeklyReportAction", () => {
  it("refuses without a session and never builds the service", async () => {
    sessionMock.getSession.mockResolvedValue(null);

    await expect(saveWeeklyReportAction(INPUT)).resolves.toEqual({
      ok: false,
      message: "Debes iniciar sesión para continuar.",
    });
    expect(weeklyMock.createWeeklyReportsService).not.toHaveBeenCalled();
  });

  it("discards a forged cell payload from an ordinary member", async () => {
    sessionMock.getSession.mockResolvedValue(MEMBER);
    const saveReport = fakeWeeklyService();

    await expect(saveWeeklyReportAction(INPUT)).resolves.toEqual({ ok: true });

    expect(saveReport).toHaveBeenCalledWith(
      { userId: MEMBER.userId, role: MEMBER.role },
      {
        attended: true,
        discipleshipAttended: false,
        cellsTotal: 0,
        cellsHeld: 0,
        cellsNotHeld: 0,
        cellAttendees: 0,
        cellAbsentees: 0,
        cellNewVisitors: 0,
        cellNewCells: 0,
        visitors: [],
        note: null,
      },
    );
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/portal/semana");
  });

  it("lets the member-tree root persist the full report", async () => {
    sessionMock.getSession.mockResolvedValue(PASTOR);
    const saveReport = fakeWeeklyService();

    await expect(saveWeeklyReportAction(INPUT)).resolves.toEqual({ ok: true });

    expect(saveReport).toHaveBeenCalledWith(
      { userId: PASTOR.userId, role: PASTOR.role },
      {
        attended: true,
        discipleshipAttended: false,
        ...FORGED_COUNTERS,
        visitors: ["Visitante"],
        note: "Nota de células",
      },
    );
  });
});
