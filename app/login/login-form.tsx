"use client";

// =============================================================================
// app/login/login-form.tsx — the login form.
//
// Client component: react-hook-form owns the field state and Zod validates it
// for instant feedback, then a Server Action performs the actual check.
//
// Why BOTH validators: the shared `loginSchema` in lib/auth/schema.ts is used
// here through zodResolver and again inside `loginAction`. The client copy is
// a UX affordance — it never touches a database — and the server copy is the
// authority. Sharing one definition is what stops them from drifting, so the
// same typo shows the same message before and after the round trip.
//
// UI copy is in Spanish because that is the product's language (see the §6
// catalog and the seed's payment-method labels). This is not the persona or the
// conversation language leaking into an artifact; it is the project's existing
// convention for user-facing strings.
// =============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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

import { loginAction } from "@/lib/auth/actions";
import { loginSchema, type LoginInput } from "@/lib/auth/schema";

export function LoginForm({ nextPath }: { nextPath: string | null }) {
  const router = useRouter();

  // Server-level failures that are not tied to one field: wrong credentials, a
  // suspended account, or a server that cannot issue sessions right now.
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    mode: "onSubmit",
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await loginAction(values, nextPath);

      if (result.ok) {
        // refresh() rather than a bare push: the middleware and the server
        // components both re-read the cookie that was just set.
        router.replace(result.redirectTo ?? "/");
        router.refresh();
        return;
      }

      if (result.fieldErrors) {
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          if (field === "email" || field === "password") {
            setError(field, { type: "server", message });
          }
        }
        return;
      }

      setFormError(result.message ?? "No se pudo iniciar sesión.");
    } catch (error) {
      // A thrown Server Action is a real fault (not a credential problem), and
      // the browser shows Next's own error overlay for it. Re-throwing keeps
      // that visible instead of dressing it up as a validation message.
      console.error("[login] action threw:", error);
      throw error;
    }
  });

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Iniciar sesión</CardTitle>
        <CardDescription>
          Ingresa con el correo y la contraseña con los que te registró tu patrocinador.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {formError ? (
            <p
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {formError}
            </p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="email">Correo electrónico</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              placeholder="nombre@dominio.com"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? "email-error" : undefined}
              disabled={isSubmitting}
              {...register("email")}
            />
            {errors.email ? (
              <p id="email-error" role="alert" className="text-sm text-destructive">
                {errors.email.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "password-error" : undefined}
              disabled={isSubmitting}
              {...register("password")}
            />
            {errors.password ? (
              <p id="password-error" role="alert" className="text-sm text-destructive">
                {errors.password.message}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Verificando…" : "Entrar"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Si no recuerdas tu contraseña, pide un restablecimiento a tu patrocinador.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}