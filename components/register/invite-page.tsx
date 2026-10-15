// =============================================================================
// components/register/invite-page.tsx — what `/r/{code}` and `/invite/{token}`
// render, shared because the two differ only in the parameter's name.
//
// Resolution happens HERE, on the server, against the same service the API
// uses: an invalid, revoked, expired or exhausted invitation never reaches a
// form that could not be submitted (§8.3 step 1 — "página de error explícita").
// The error message is the service's own generic one: the page is public, and
// a distinction between "revoked" and "never existed" is information the
// holder of a guessed link has not earned.
// =============================================================================

import { prisma } from "@/lib/db";
import { InviteInvalidError, createInvitationsService } from "@/lib/invitations";
import { settings } from "@/lib/settings";

import { RegisterForm } from "./register-form";

export async function InvitePage({ slug }: { slug: string }) {
  let resolution;
  try {
    resolution = await createInvitationsService(prisma, settings).resolveInvite(slug);
  } catch (error) {
    if (error instanceof InviteInvalidError) {
      return (
        <InviteError
          title="Invitación no válida"
          description={error.message}
        />
      );
    }
    throw error;
  }

  if (resolution.slots.left <= 0) {
    return (
      <InviteError
        title="Sin cupos disponibles"
        description={`${resolution.sponsor.fullName} ya no tiene cupos de referido disponibles. Pídele que libere o amplíe su cupo y vuelve a intentar con este mismo link.`}
      />
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-muted/40 p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Red de Referidos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Registro por invitación
            {resolution.kind === "SINGLE" ? " (link de un solo uso)" : ""}.
          </p>
        </div>

        <RegisterForm
          invite={slug}
          fields={resolution.fields}
          sponsorName={resolution.sponsor.fullName}
          slotsLeft={resolution.slots.left}
        />
      </div>
    </main>
  );
}

function InviteError({ title, description }: { title: string; description: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-background p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        <p className="text-sm">
          Si crees que es un error, pide a tu patrocinador un link nuevo.{" "}
          <a className="underline" href="/login">
            ¿Ya tienes cuenta? Inicia sesión
          </a>
          .
        </p>
      </div>
    </main>
  );
}
