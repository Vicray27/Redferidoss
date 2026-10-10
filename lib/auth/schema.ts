// =============================================================================
// lib/auth/schema.ts — the login form contract, shared by both sides.
//
// The SAME schema validates on the client (react-hook-form + zodResolver, for
// instant feedback) and on the server (the server action, as the authority).
// Sharing one definition means the two can never disagree about what a valid
// login is.
//
// Isomorphic on purpose: no `next/*`, no Prisma, so a Client Component and a
// Server Action can both import it.
//
// Messages are in Spanish because they are rendered verbatim in the form. The
// project rule is that UI copy follows the product's language (the catalog in
// lib/settings-catalog.ts and the seed's payment-method labels are already
// Spanish), not that source comments are.
// =============================================================================

import { z } from "zod";

/**
 * `password` is only checked for NON-EMPTINESS here, never for a policy.
 *
 * A login form cannot enforce a password policy: the rule belongs where a
 * password is chosen or changed (registration, password reset), not where an
 * existing hash is being checked. Rejecting "short" passwords at login would
 * lock out every account created before the policy tightened, and the hash
 * carries no length to inspect anyway. The minimum length policy lives with
 * `scripts/set-password.ts` and the future registration flow.
 */
export const loginSchema = z.object({
  email: z
    .string({ error: "El correo es obligatorio" })
    .trim()
    .min(1, "El correo es obligatorio")
    .max(254, "El correo es demasiado largo")
    .email("Ingresa un correo válido, por ejemplo nombre@dominio.com"),
  password: z
    .string({ error: "La contraseña es obligatoria" })
    .min(1, "La contraseña es obligatoria")
    .max(200, "La contraseña es demasiado larga"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Map a ZodError to the first message per field.
 *
 * zodResolver does this for react-hook-form, but the server action needs it
 * too, and the two must render the same first error — otherwise the same typo
 * would show one message on the client and a different one after a round trip.
 */
export function firstIssuesByField(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && out[field] === undefined) {
      out[field] = issue.message;
    }
  }
  return out;
}