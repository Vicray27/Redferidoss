// =============================================================================
// tests/settings-actions.test.ts — the Server Action behind /admin/configuracion
// (WU4).
//
// The action is a thin orchestrator (§18): session check, empty-change guard,
// service call, cache invalidation and revalidation. Those branches are what
// this file pins, with the session, the admin service and next/cache mocked;
// the validation rules themselves are covered by tests/settings-admin.test.ts.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ getSession: vi.fn() }));
const cacheMock = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const settingsMock = vi.hoisted(() => ({ settings: { invalidate: vi.fn() } }));
const adminMock = vi.hoisted(() => ({ createSettingsAdminService: vi.fn() }));

vi.mock("@/lib/auth/require", () => sessionMock);
vi.mock("next/cache", () => cacheMock);
vi.mock("@/lib/settings", () => settingsMock);
vi.mock("@/lib/settings-admin", () => adminMock);
vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { SessionPayload } from "@/lib/auth/session";
import { AppError } from "../lib/errors";
import { updateSettingsAction } from "../lib/settings-actions";

const SESSION = {
  userId: "admin-1",
  role: "ADMIN",
  publicCode: "ADM01",
  fullName: "Admin",
} as SessionPayload;

function fakeService(update: ReturnType<typeof vi.fn>) {
  adminMock.createSettingsAdminService.mockReturnValue({ update } as never);
  return update;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateSettingsAction", () => {
  it("refuses without a session and never touches the service", async () => {
    sessionMock.getSession.mockResolvedValue(null);

    await expect(updateSettingsAction([{ key: "x", value: 1 }])).resolves.toEqual({
      ok: false,
      message: "Debes iniciar sesión para continuar.",
    });
    expect(adminMock.createSettingsAdminService).not.toHaveBeenCalled();
  });

  it("refuses an empty change list", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);

    await expect(updateSettingsAction([])).resolves.toEqual({
      ok: false,
      message: "No hay cambios para guardar.",
    });
    expect(adminMock.createSettingsAdminService).not.toHaveBeenCalled();
  });

  it("updates, invalidates the local cache and revalidates both screens", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    const update = fakeService(
      vi.fn().mockResolvedValue([{ key: "payments.currency" }, { key: "payments.grace_hours" }]),
    );
    const changes = [
      { key: "payments.currency", value: "USD" },
      { key: "payments.grace_hours", value: 48 },
    ];

    await expect(updateSettingsAction(changes)).resolves.toEqual({
      ok: true,
      updated: ["payments.currency", "payments.grace_hours"],
    });

    expect(update).toHaveBeenCalledWith({ id: "admin-1", role: "ADMIN" }, changes);
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/admin/configuracion");
    expect(cacheMock.revalidatePath).toHaveBeenCalledWith("/portal/semana");
  });

  it("wires the invalidate callback to the process-wide settings cache", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService(vi.fn().mockResolvedValue([]));

    await updateSettingsAction([{ key: "payments.currency", value: "USD" }]);

    const options = adminMock.createSettingsAdminService.mock.calls[0]?.[1] as {
      invalidate: (key: string) => void;
    };
    options.invalidate("payments.currency");
    expect(settingsMock.settings.invalidate).toHaveBeenCalledWith("payments.currency");
  });

  it("returns the AppError message as a failed result, without revalidating", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService(
      vi.fn().mockRejectedValue(new AppError(400, "INVALID_SETTING", "Valor fuera de rango")),
    );

    await expect(updateSettingsAction([{ key: "x", value: 1 }])).resolves.toEqual({
      ok: false,
      message: "Valor fuera de rango",
    });
    expect(cacheMock.revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors instead of hiding them", async () => {
    sessionMock.getSession.mockResolvedValue(SESSION);
    fakeService(vi.fn().mockRejectedValue(new Error("db down")));

    await expect(updateSettingsAction([{ key: "x", value: 1 }])).rejects.toThrow("db down");
  });
});
