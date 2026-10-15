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
// `custom` is intentionally `Record<string, unknown>`: its shape is data, and
// pretending otherwise here would freeze a dynamic form into a static type.
//
// Empty strings are ALLOWED for the optional profile fields: the form sends
// what the HTML form holds, and `emptyToNull` in lib/registration.ts is the
// single place that decides "" means NULL.
// =============================================================================

import { z } from "zod";

export const REGISTER_MIN_PASSWORD_LENGTH = 8;

export const registerCoreSchema = z.object({
  invite: z
    .string({ error: "Falta el link de invitación" })
    .trim()
    .min(1, "Falta el link de invitación")
    .max(128, "El link de invitación no es válido"),

  email: z
    .string({ error: "El correo es obligatorio" })
    .trim()
    .min(1, "El correo es obligatorio")
    .max(254, "El correo es demasiado largo")
    .email("Ingresa un correo válido, por ejemplo nombre@dominio.com"),

  password: z
    .string({ error: "La contraseña es obligatoria" })
    .min(
      REGISTER_MIN_PASSWORD_LENGTH,
      `La contraseña debe tener al menos ${REGISTER_MIN_PASSWORD_LENGTH} caracteres`,
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

export type RegisterCoreInput = z.infer<typeof registerCoreSchema>;
