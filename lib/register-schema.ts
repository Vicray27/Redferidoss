// =============================================================================
// lib/register-schema.ts — the registration form contract, shared by both
// sides, exactly like lib/auth/schema.ts.
//
// The SAME schema validates in the browser (fast feedback) and in the route
// handler (the authority). It covers the FIXED fields only: the custom fields
// are user-configured rows (`custom_fields`, entity USER, show_in_registration)
// and their validation lives with the server side that re-reads them inside
// the transaction (lib/registration.ts, collectCustomValues). A client can
// therefore never smuggle a rule in by editing the page's schema — the
// database definitions win.
//
// F8: the password minimum is a SETTINGS value now
// (`security.password_min_length`, §18.3), so the schema is built by a
// factory. The route handler and the form each pass the value they read; the
// module-level `registerCoreSchema` exists so tests and legacy callers keep a
// schema with the §6 floor. The floor itself is enforced where the value is
// read (lib/security-settings.ts), never here.
//
// `custom` is intentionally `Record<string, unknown>`: its shape is data, and
// pretending otherwise here would freeze a dynamic form into a static type.
//
// Empty strings are ALLOWED for the optional profile fields: the form sends
// what the HTML form holds, and `emptyToNull` in lib/registration.ts is the
// single place that decides "" means NULL.
// =============================================================================

import { z } from "zod";

import { PASSWORD_MIN_LENGTH_FLOOR } from "./security-settings";

/**
 * The client-side default and §6 floor. Kept exported under its historical
 * name; the effective minimum comes from settings and can only go UP.
 */
export const REGISTER_MIN_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH_FLOOR;

/** Build the registration schema with a specific password minimum. */
export function createRegisterCoreSchema(
  minPasswordLength: number = REGISTER_MIN_PASSWORD_LENGTH,
) {
  if (!Number.isInteger(minPasswordLength) || minPasswordLength < REGISTER_MIN_PASSWORD_LENGTH) {
    throw new RangeError(
      `password minimum must be an integer >= ${REGISTER_MIN_PASSWORD_LENGTH} (got ${minPasswordLength}); ` +
        `the floor is a security constant, the configured value may only raise it`,
    );
  }

  return z.object({
    invite: z
      .string({ error: "Falta el enlace de invitación" })
      .trim()
      .min(1, "Falta el enlace de invitación")
      .max(128, "El enlace de invitación no es válido"),

    email: z
      .string({ error: "El correo es obligatorio" })
      .trim()
      .min(1, "El correo es obligatorio")
      .max(254, "El correo es demasiado largo")
      .email("Ingresa un correo válido, por ejemplo nombre@dominio.com"),

    password: z
      .string({ error: "La contraseña es obligatoria" })
      .min(
        minPasswordLength,
        `La contraseña debe tener al menos ${minPasswordLength} caracteres`,
      )
      .max(200, "La contraseña es demasiado larga"),

    fullName: z
      .string({ error: "El nombre es obligatorio" })
      .trim()
      .min(2, "Ingresa tu nombre completo")
      .max(120, "El nombre es demasiado largo"),

    nationalId: z.string().trim().max(40, "El documento es demasiado largo").optional(),
    phone: z.string().trim().max(40, "El teléfono es demasiado largo").optional(),
    birthDate: z
      .union([
        z.literal(""),
        z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa el formato AAAA-MM-DD"),
      ])
      .optional(),
    country: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    address: z.string().trim().max(200).optional(),

    custom: z.record(z.string(), z.unknown()).optional(),
  });
}

/** Default schema at the §6 floor; call sites with settings use the factory. */
export const registerCoreSchema = createRegisterCoreSchema();

export type RegisterCoreInput = z.infer<typeof registerCoreSchema>;
