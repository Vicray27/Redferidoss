// =============================================================================
// tests/register-schema.test.ts — the registration form contract (WU4).
//
// lib/register-schema.ts is the schema the browser and the route handler
// SHARE: the same rules run on both sides, so every message asserted here is
// also what the user sees. The F8 change pinned by these tests is the factory:
// `security.password_min_length` may only RAISE the §6 floor, and the message
// must name the configured value instead of the constant.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  createRegisterCoreSchema,
  REGISTER_MIN_PASSWORD_LENGTH,
  registerCoreSchema,
} from "../lib/register-schema";

/** Minimum payload that passes at the default floor. */
function validInput(overrides: Record<string, unknown> = {}) {
  return {
    invite: "demo-invite-token",
    email: "ana@example.com",
    password: "clave-larga-123",
    fullName: "Ana Pérez",
    ...overrides,
  };
}

function firstMessage(result: { success: boolean; error?: { issues: Array<{ message: string }> } }) {
  return result.error?.issues[0]?.message;
}

describe("createRegisterCoreSchema — password floor (F8, §18.3)", () => {
  it("exposes the §6 floor as REGISTER_MIN_PASSWORD_LENGTH", () => {
    expect(REGISTER_MIN_PASSWORD_LENGTH).toBe(8);
  });

  it("the module-level schema uses the floor", () => {
    const result = registerCoreSchema.safeParse(validInput({ password: "12345678" }));
    expect(result.success).toBe(true);
  });

  it("rejects a minimum below the floor with a RangeError", () => {
    expect(() => createRegisterCoreSchema(7)).toThrow(RangeError);
    expect(() => createRegisterCoreSchema(7)).toThrow(/may only raise it/);
  });

  it("rejects non-integer minimums", () => {
    expect(() => createRegisterCoreSchema(8.5)).toThrow(RangeError);
    expect(() => createRegisterCoreSchema(Number.NaN)).toThrow(RangeError);
  });

  it("accepts the floor and values above it", () => {
    expect(() => createRegisterCoreSchema(8)).not.toThrow();
    expect(() => createRegisterCoreSchema(12)).not.toThrow();
  });

  it("a raised minimum rejects shorter passwords and names the configured value", () => {
    const schema = createRegisterCoreSchema(12);
    const result = schema.safeParse(validInput({ password: "once-caract" }));

    expect(result.success).toBe(false);
    expect(firstMessage(result)).toBe("La contraseña debe tener al menos 12 caracteres");
  });

  it("a raised minimum accepts passwords of exactly that length", () => {
    const schema = createRegisterCoreSchema(12);
    const result = schema.safeParse(validInput({ password: "doce-caracts" }));

    expect(result.success).toBe(true);
  });
});

describe("register schema — fixed fields", () => {
  it("trims email and fullName and keeps the rest", () => {
    const result = registerCoreSchema.safeParse(
      validInput({ email: "  ana@example.com  ", fullName: "  Ana Pérez  " }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe("ana@example.com");
    expect(result.data?.fullName).toBe("Ana Pérez");
  });

  it("requires a non-empty invite link", () => {
    const missing = registerCoreSchema.safeParse(validInput({ invite: undefined }));
    expect(firstMessage(missing)).toBe("Falta el link de invitación");

    const blank = registerCoreSchema.safeParse(validInput({ invite: "   " }));
    expect(firstMessage(blank)).toBe("Falta el link de invitación");
  });

  it("rejects an invite link longer than 128 characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ invite: "x".repeat(129) }));
    expect(firstMessage(result)).toBe("El link de invitación no es válido");
  });

  it("rejects invalid email with the example message", () => {
    const result = registerCoreSchema.safeParse(validInput({ email: "no-es-correo" }));
    expect(firstMessage(result)).toBe(
      "Ingresa un correo válido, por ejemplo nombre@dominio.com",
    );
  });

  it("rejects an empty email", () => {
    const result = registerCoreSchema.safeParse(validInput({ email: "" }));
    expect(firstMessage(result)).toBe("El correo es obligatorio");
  });

  it("rejects a full name shorter than two characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ fullName: "A" }));
    expect(firstMessage(result)).toBe("Ingresa tu nombre completo");
  });

  it("rejects passwords longer than 200 characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ password: "x".repeat(201) }));
    expect(firstMessage(result)).toBe("La contraseña es demasiado larga");
  });

  it("rejects a national id or phone longer than 40 characters", () => {
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ nationalId: "1".repeat(41) })))).toBe(
      "El documento es demasiado largo",
    );
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ phone: "1".repeat(41) })))).toBe(
      "El teléfono es demasiado largo",
    );
  });

  it("accepts the empty birthDate the form sends, and the ISO format", () => {
    expect(registerCoreSchema.safeParse(validInput({ birthDate: "" })).success).toBe(true);
    expect(registerCoreSchema.safeParse(validInput({ birthDate: "1990-05-17" })).success).toBe(true);
  });

  it("rejects a non-ISO birthDate with the format message", () => {
    const result = registerCoreSchema.safeParse(validInput({ birthDate: "17/05/1990" }));
    expect(firstMessage(result)).toBe("Usa el formato AAAA-MM-DD");
  });

  it("caps address at 200 characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ address: "a".repeat(201) }));
    expect(result.success).toBe(false);
  });

  it("keeps custom values as data and strips unknown top-level keys", () => {
    const result = registerCoreSchema.safeParse(
      validInput({ custom: { barrio: "Centro" }, rogue: "smuggled" }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.custom).toEqual({ barrio: "Centro" });
    // Client-side typing only: a field the contract does not define is dropped.
    expect(result.data && "rogue" in result.data).toBe(false);
  });
});
