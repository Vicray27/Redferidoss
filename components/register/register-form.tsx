"use client";

// =============================================================================
// components/register/register-form.tsx — the self-registration form (§8.3).
//
// Two validation layers, intentionally different in kind:
//
//   * the BASE fields (name, email, password, profile) go through
//     react-hook-form + `registerCoreSchema`, the same definition the route
//     handler validates against — one source of truth, no drift;
//   * the CUSTOM fields are dynamic (they live in `custom_fields`) and are
//     checked by the mirrored per-field rules in
//     components/dynamic-form/build-zod-schema.ts, which the server then
//     re-enforces inside its transaction.
//
// The submit posts JSON to /api/auth/register. A `{ok:false}` envelope is
// mapped back onto the offending inputs: core errors onto react-hook-form,
// everything else onto the custom map — the server's `details` decides, not
// this component's guesses.
// =============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { FieldRenderer } from "@/components/dynamic-form/field-renderer";
import { validateCustomFields } from "@/components/dynamic-form/build-zod-schema";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui/form";
import type { RegistrationField } from "@/lib/invitations";
import { registerCoreSchema } from "@/lib/register-schema";

import type { z } from "zod";

// The form renders neither `invite` (it arrives in the URL) nor `custom`
// (it is the value map below) — so its schema is the core schema minus both.
const formSchema = registerCoreSchema.omit({ invite: true, custom: true });
type FormValues = z.infer<typeof formSchema>;

export function RegisterForm({
  invite,
  fields,
  sponsorName,
  slotsLeft,
}: {
  invite: string;
  fields: RegistrationField[];
  sponsorName: string;
  slotsLeft: number;
}) {
  const router = useRouter();

  const [formError, setFormError] = useState<string | null>(null);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onSubmit",
    defaultValues: {
      email: "",
      password: "",
      fullName: "",
      nationalId: "",
      phone: "",
      birthDate: "",
      country: "",
      state: "",
      city: "",
      address: "",
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    const fieldErrors = validateCustomFields(fields, customValues);
    setCustomErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    let envelope: unknown;
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite, ...values, custom: customValues }),
      });
      envelope = await response.json();
    } catch (error) {
      console.error("[register] network failure:", error);
      setFormError("No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.");
      return;
    }

    const body = envelope as
      | { ok: true; data: { redirectTo?: string } }
      | { ok: false; error: { message?: string; details?: unknown } }
      | undefined;

    if (body?.ok) {
      router.replace(body.data.redirectTo ?? "/portal");
      router.refresh();
      return;
    }

    // The server is the authority on WHAT failed; map its details back.
    const details = (body && !body.ok ? body.error.details : undefined) as
      | Record<string, string | string[]>
      | undefined;
    if (details && typeof details === "object") {
      const remaining: Record<string, string> = {};
      for (const [field, raw] of Object.entries(details)) {
        const message = Array.isArray(raw) ? raw[0] : raw;
        if (typeof message !== "string") continue;
        if (isCoreField(field)) {
          setError(field as keyof FormValues, { type: "server", message });
        } else {
          remaining[field] = message;
        }
      }
      setCustomErrors((current) => ({ ...current, ...remaining }));
      if (Object.keys(remaining).length > 0) return;
    }

    setFormError(
      (body && !body.ok ? body.error.message : undefined) ??
        "No se pudo completar el registro. Intenta de nuevo.",
    );
  });

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Crear tu cuenta</CardTitle>
        <CardDescription>
          {slotsLeft > 0
            ? `Te invitó ${sponsorName}. Completa tus datos para unirte a su red.`
            : `Te invitó ${sponsorName}, pero en este momento no tiene cupos disponibles.`}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-5">
          {formError ? (
            <p
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {formError}
            </p>
          ) : null}

          <CoreField
            id="fullName"
            label="Nombre completo"
            error={errors.fullName?.message}
            disabled={isSubmitting}
            registration={register("fullName")}
            autoComplete="name"
          />

          <CoreField
            id="email"
            label="Correo electrónico"
            type="email"
            error={errors.email?.message}
            disabled={isSubmitting}
            registration={register("email")}
            autoComplete="username"
            placeholder="nombre@dominio.com"
            hint="Con este correo ingresarás al portal."
          />

          <CoreField
            id="password"
            label="Contraseña"
            type="password"
            error={errors.password?.message}
            disabled={isSubmitting}
            registration={register("password")}
            autoComplete="new-password"
            hint="Mínimo 8 caracteres."
          />

          {fields.map((field) => (
            <FieldRenderer
              key={field.code}
              field={field}
              value={customValues[field.code]}
              error={customErrors[field.code]}
              disabled={isSubmitting}
              onChange={(next) =>
                setCustomValues((current) => ({ ...current, [field.code]: next }))
              }
            />
          ))}

          <details className="rounded-md border bg-muted/30 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Datos opcionales
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <CoreField
                id="nationalId"
                label="Documento"
                error={errors.nationalId?.message}
                disabled={isSubmitting}
                registration={register("nationalId")}
                compact
              />
              <CoreField
                id="phone"
                label="Teléfono"
                type="tel"
                error={errors.phone?.message}
                disabled={isSubmitting}
                registration={register("phone")}
                autoComplete="tel"
                compact
              />
              <CoreField
                id="birthDate"
                label="Fecha de nacimiento"
                type="date"
                error={errors.birthDate?.message}
                disabled={isSubmitting}
                registration={register("birthDate")}
                compact
              />
              <CoreField
                id="country"
                label="País"
                error={errors.country?.message}
                disabled={isSubmitting}
                registration={register("country")}
                autoComplete="country-name"
                compact
              />
              <CoreField
                id="state"
                label="Estado / provincia"
                error={errors.state?.message}
                disabled={isSubmitting}
                registration={register("state")}
                autoComplete="address-level1"
                compact
              />
              <CoreField
                id="city"
                label="Ciudad"
                error={errors.city?.message}
                disabled={isSubmitting}
                registration={register("city")}
                autoComplete="address-level2"
                compact
              />
              <CoreField
                id="address"
                label="Dirección"
                error={errors.address?.message}
                disabled={isSubmitting}
                registration={register("address")}
                autoComplete="street-address"
                compact
              />
            </div>
          </details>

          <Button type="submit" className="w-full" disabled={isSubmitting || slotsLeft <= 0}>
            {isSubmitting ? "Creando tu cuenta…" : "Registrarme"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Al registrarte aceptas participar de la red de {sponsorName}. ¿Ya
            tienes cuenta?{" "}
            <a className="underline" href="/login">
              Inicia sesión
            </a>
            .
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

const CORE_FIELDS = new Set([
  "email",
  "password",
  "fullName",
  "nationalId",
  "phone",
  "birthDate",
  "country",
  "state",
  "city",
  "address",
]);

function isCoreField(field: string): boolean {
  return CORE_FIELDS.has(field);
}

function CoreField({
  id,
  label,
  error,
  disabled,
  registration,
  type,
  autoComplete,
  placeholder,
  hint,
  compact = false,
}: {
  id: string;
  label: string;
  error?: string;
  disabled: boolean;
  registration: UseFormRegisterReturn;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  compact?: boolean;
}) {
  const errorId = `${id}-error`;
  return (
    <div className={compact ? "space-y-2" : "space-y-2"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        {...registration}
      />
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
