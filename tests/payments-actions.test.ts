// =============================================================================
// tests/payments-actions.test.ts — the Server Actions behind /portal/semana
// and /admin/revisiones (WU4).
//
// The actions do NO business work (D29): session check, service call, path
// revalidation, and AppError-to-message mapping — including the
// `details` -> fieldErrors conversion, which is the only non-trivial logic in
// the file. The rules themselves (window, ownership, review authority) are
// covered by tests/payments.test.ts and tests/payments-bulk.test.ts.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ getSession: vi.fn() }));
const cacheMock = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const paymentsMock = vi.hoisted(() => ({ createPaymentsService: vi.fn() }));

vi.mock("@/lib/auth/require", () => sessionMock);
vi.mock("next/cache", () => cacheMock);
vi.mock("@/lib/payments", () => paymentsMock);
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/settings", () => ({ settings: {} }));
vi.mock("@/lib/authz", () => ({ authorization: {} }));

import type { SessionPayload } from "@/lib/auth/session";
import { AppError } from "../lib/errors";
import {
  bulkReviewPaymentsAction,
  reassignPaymentsAction,
  reviewPaymentReportAction,
  submitPaymentReportAction,
} from "../lib/payments-actions";

const SESSION = {
  userId: "u-1",
  role: "MEMBER",
  publicCode: "ABC123",
  fullName: "Ana",
} as SessionPayload;

const STAFF = { ...SESSION, role: "ADMIN" } as SessionPayload;

function fakeService(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  paymentsMock.createPaymentsService.mockReturnValue(overrides as never);
  return overrides;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitPaymentReportAction", () => {
  it("refuses without a session and never builds the service", async () => {
    sessionMock.getSession.mockResolvedValue(null);

    await expect(
      submitPaymentReportAction({ amount: "10", methodId: "m-1", paidAt: "2026-10-12" }),
    ).resolves.toEqual({ ok: false, message: "Debes iniciar sesión para continuar." });
    expect(paymentsMock.createPaymentsService).not.toHaveBeenCalled();
  });

  it("reports with the caller's identity, normalises omitted optionals to null and revalidates", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    const createReport = vi.fn().mockResolvedValue({ id: "r-1" });
    fakeService({ createReport });

    await expect(
      submitPaymentReportAction({ amount: "10.00", methodId: "m-1", paidAt: "2026-10-12" }),
    ).resolves.toEqual({ ok: true, reportId: "r-1" });

    expect(createReport).toHaveBeenCalledWith(
      { id: "u-1", role: "MEMBER" },
      {
        amount: "10.00",
        methodId: "m-1",
        reference: null,
        paidAt: "2026-10-12",
        note: null,
        proofKey: null,
        custom: null,
      },
    );
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/portal/semana");
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/portal");
  });

  it("maps AppError.details to the FIRST message per field", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService({
      createReport: vi.fn().mockRejectedValue(
        new AppError(422, "VALIDATION", "Revisa el formulario", {
          amount: ["El monto es obligatorio", "segundo mensaje"],
          reference: "Referencia inválida",
          ignored: 42,
        }),
      ),
    });

    await expect(
      submitPaymentReportAction({ amount: "", methodId: "m-1", paidAt: "2026-10-12" }),
    ).resolves.toEqual({
      ok: false,
      message: "Revisa el formulario",
      fieldErrors: {
        amount: "El monto es obligatorio",
        reference: "Referencia inválida",
      },
    });
  });

  it("omits fieldErrors when details is not a plain object", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService({
      createReport: vi
        .fn()
        .mockRejectedValue(new AppError(409, "CONFLICT", "Ya existe un reporte", ["a", "b"])),
    });

    await expect(
      submitPaymentReportAction({ amount: "10", methodId: "m-1", paidAt: "2026-10-12" }),
    ).resolves.toEqual({ ok: false, message: "Ya existe un reporte" });
  });

  it("rethrows unexpected errors instead of dressing them as validation", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService({ createReport: vi.fn().mockRejectedValue(new Error("db down")) });

    await expect(
      submitPaymentReportAction({ amount: "10", methodId: "m-1", paidAt: "2026-10-12" }),
    ).rejects.toThrow("db down");
  });
});

describe("reviewPaymentReportAction", () => {
  it("refuses without a session", async () => {
    sessionMock.getSession.mockResolvedValue(null);

    await expect(
      reviewPaymentReportAction({ reportId: "r-1", decision: "APPROVED" }),
    ).resolves.toEqual({ ok: false, message: "Debes iniciar sesión para continuar." });
  });

  it("reviews under the caller's identity and revalidates the review screen", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    const reviewReport = vi.fn().mockResolvedValue({ id: "r-1" });
    fakeService({ reviewReport });

    await expect(
      reviewPaymentReportAction({ reportId: "r-1", decision: "APPROVED", note: "ok" }),
    ).resolves.toEqual({ ok: true, reportId: "r-1" });

    expect(reviewReport).toHaveBeenCalledWith({ id: "u-1", role: "ADMIN" }, "r-1", "APPROVED", "ok");
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/admin/revisiones");
  });

  it("maps a ForbiddenError-shaped AppError to its message", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reviewReport: vi
        .fn()
        .mockRejectedValue(new AppError(403, "FORBIDDEN", "No tienes permiso para revisar")),
    });

    await expect(
      reviewPaymentReportAction({ reportId: "r-1", decision: "REJECTED" }),
    ).resolves.toEqual({ ok: false, message: "No tienes permiso para revisar" });
  });
});

describe("bulkReviewPaymentsAction", () => {
  it("renders singular and plural labels and revalidates the three screens", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    const reviewMany = vi.fn().mockResolvedValue({
      approved: 2,
      rejected: 1,
      skipped: [{ reportId: "s-1", reason: "NOT_PENDING" }],
    });
    fakeService({ reviewMany });

    await expect(
      bulkReviewPaymentsAction({ reportIds: ["a", "b", "c"], decision: "APPROVED" }),
    ).resolves.toMatchObject({
      ok: true,
      summary: "2 aprobados · 1 rechazado · 1 omitido",
      approved: 2,
      rejected: 1,
    });

    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/admin");
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/admin/pagos");
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/admin/revisiones");
  });

  it("uses the singular form for a count of one", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reviewMany: vi.fn().mockResolvedValue({ approved: 1, rejected: 0, skipped: [] }),
    });

    await expect(
      bulkReviewPaymentsAction({ reportIds: ["a"], decision: "APPROVED" }),
    ).resolves.toMatchObject({ summary: "1 aprobado" });
  });

  it("says there was nothing to do when every count is zero", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reviewMany: vi.fn().mockResolvedValue({ approved: 0, rejected: 0, skipped: [] }),
    });

    await expect(
      bulkReviewPaymentsAction({ reportIds: [], decision: "REJECTED" }),
    ).resolves.toMatchObject({ ok: true, summary: "No había nada por hacer." });
  });
});

describe("reassignPaymentsAction", () => {
  it("names the target period and counts the moved reports", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reassignReports: vi.fn().mockResolvedValue({
        moved: 3,
        skipped: [],
        target: { periodKey: "2026-W41" },
      }),
    });

    await expect(
      reassignPaymentsAction({ reportIds: ["a", "b", "c"], targetCycleId: "c-2" }),
    ).resolves.toMatchObject({ ok: true, summary: "3 reasignados a 2026-W41", moved: 3 });
  });

  it("uses the singular form for one moved report", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reassignReports: vi.fn().mockResolvedValue({
        moved: 1,
        skipped: [],
        target: { periodKey: "2026-W41" },
      }),
    });

    await expect(
      reassignPaymentsAction({ reportIds: ["a"], targetCycleId: "c-2" }),
    ).resolves.toMatchObject({ summary: "1 reasignado a 2026-W41" });
  });

  it("summarises skips when nothing moved", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reassignReports: vi.fn().mockResolvedValue({
        moved: 0,
        skipped: [{ reportId: "s-1" }, { reportId: "s-2" }],
        target: { periodKey: "2026-W41" },
      }),
    });

    await expect(
      reassignPaymentsAction({ reportIds: ["a"], targetCycleId: "c-2" }),
    ).resolves.toMatchObject({ summary: "2 omitidos", moved: 0 });
  });

  it("says there was nothing to do when nothing moved and nothing was skipped", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reassignReports: vi
        .fn()
        .mockResolvedValue({ moved: 0, skipped: [], target: { periodKey: "2026-W41" } }),
    });

    await expect(
      reassignPaymentsAction({ reportIds: [], targetCycleId: "c-2" }),
    ).resolves.toMatchObject({ summary: "No había nada por hacer." });
  });

  it("maps an AppError to a failed result", async () => {
    sessionMock.getSession.mockResolvedValue(STAFF);
    fakeService({
      reassignReports: vi
        .fn()
        .mockRejectedValue(new AppError(409, "CLOSED_CYCLE", "El ciclo destino está cerrado")),
    });

    await expect(
      reassignPaymentsAction({ reportIds: ["a"], targetCycleId: "c-2" }),
    ).resolves.toEqual({ ok: false, message: "El ciclo destino está cerrado" });
  });
});
