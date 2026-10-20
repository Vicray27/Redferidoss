// =============================================================================
// tests/register-schema.test.ts — the registration form contract (WU4).
//
// lib/register-schema.ts is the schema the browser and the route handler
// SHARE: the same rules run on both sides, so every message asserted here is
// also what the user sees. The F8 change pinned by these tests is the factory:
// `security.password_min_length` may only RAISE the §6 floor, and the message
// must name the configured value instead of the constant.
//
// D86 adds the identity rules: username required (lower-cased), cédula
// required, email optional.
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
    username: "ana.perez",
    nationalId: "V-12345678",
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

describe("register schema — identity fields (D86)", () => {
  it("lower-cases and trims the username", () => {
    const result = registerCoreSchema.safeParse(validInput({ username: "  Ana.Perez  " }));
    expect(result.success).toBe(true);
    expect(result.data?.username).toBe("ana.perez");
  });

  it("accepts the documented username alphabet", () => {
    for (const username of ["ana", "ana.perez", "ana_perez", "ana-perez", "ana123"]) {
      expect(registerCoreSchema.safeParse(validInput({ username })).success).toBe(true);
    }
  });

  it("requires a username", () => {
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "" })))).toBe(
      "El usuario es obligatorio.",
    );
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "   " })))).toBe(
      "El usuario es obligatorio.",
    );
  });

  it("rejects usernames outside 3–30 legal characters with one clear message", () => {
    const message =
      "El usuario debe tener entre 3 y 30 caracteres: minúsculas, números, punto, guion o guion bajo.";

    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "ab" })))).toBe(message);
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "a".repeat(31) })))).toBe(
      message,
    );
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "ana perez" })))).toBe(
      message,
    );
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ username: "ana@perez" })))).toBe(
      message,
    );
  });

  it("rejects reserved handles", () => {
    for (const username of ["admin", "ROOT", "Sistema", "soporte"]) {
      expect(firstMessage(registerCoreSchema.safeParse(validInput({ username })))).toBe(
        "Ese usuario no está disponible.",
      );
    }
  });

  it("requires a cédula", () => {
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ nationalId: "" })))).toBe(
      "La cédula es obligatoria.",
    );
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ nationalId: "   " })))).toBe(
      "La cédula es obligatoria.",
    );
  });

  it("accepts a cédula with letters, digits and hyphens", () => {
    expect(registerCoreSchema.safeParse(validInput({ nationalId: "V-12.345.678" })).success).toBe(
      true,
    );
    expect(registerCoreSchema.safeParse(validInput({ nationalId: "E-12345678" })).success).toBe(
      true,
    );
  });

  it("caps the cédula at 40 characters", () => {
    expect(firstMessage(registerCoreSchema.safeParse(validInput({ nationalId: "1".repeat(41) })))).toBe(
      "La cédula es demasiado larga.",
    );
  });
});

describe("register schema — optional email", () => {
  it("accepts an omitted email", () => {
    const { email: _email, ...withoutEmail } = validInput();
    expect(registerCoreSchema.safeParse(withoutEmail).success).toBe(true);
  });

  it("accepts the empty string the form sends", () => {
    expect(registerCoreSchema.safeParse(validInput({ email: "" })).success).toBe(true);
    expect(registerCoreSchema.safeParse(validInput({ email: "   " })).success).toBe(true);
  });

  it("still rejects a malformed address with the example message", () => {
    const result = registerCoreSchema.safeParse(validInput({ email: "no-es-correo" }));
    expect(firstMessage(result)).toBe(
      "Ingresa un correo válido, por ejemplo nombre@dominio.com",
    );
  });

  it("caps the email at 254 characters", () => {
    const result = registerCoreSchema.safeParse(
      validInput({ email: `${"a".repeat(250)}@example.com` }),
    );
    expect(firstMessage(result)).toBe("El correo es demasiado largo");
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
    expect(firstMessage(missing)).toBe("Falta el enlace de invitación");

    const blank = registerCoreSchema.safeParse(validInput({ invite: "   " }));
    expect(firstMessage(blank)).toBe("Falta el enlace de invitación");
  });

  it("rejects an invite link longer than 128 characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ invite: "x".repeat(129) }));
    expect(firstMessage(result)).toBe("El enlace de invitación no es válido");
  });

  it("rejects a full name shorter than two characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ fullName: "A" }));
    expect(firstMessage(result)).toBe("Ingresa tu nombre completo");
  });

  it("rejects passwords longer than 200 characters", () => {
    const result = registerCoreSchema.safeParse(validInput({ password: "x".repeat(201) }));
    expect(firstMessage(result)).toBe("La contraseña es demasiado larga");
  });

  it("rejects a phone longer than 40 characters", () => {
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
