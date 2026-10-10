// =============================================================================
// components/session-shell.tsx — the frame every signed-in page renders inside.
//
// Small on purpose. F2 only has to prove that a session EXISTS and carries the
// right identity; the dashboards themselves are F5. Extracting the header and
// the sign-out form here keeps /admin and /portal from growing two copies of
// the same markup, which is how the two areas end up disagreeing about what a
// user sees.
// =============================================================================

import type { SessionPayload } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";

const ROLE_LABEL: Record<SessionPayload["role"], string> = {
  ROOT: "Administrador raíz",
  ADMIN: "Administrador",
  MEMBER: "Referido",
};

export function SessionShell({
  session,
  title,
  description,
  children,
}: {
  session: SessionPayload;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">Red de Referidos</p>
            <p className="truncate text-xs text-muted-foreground">{session.fullName}</p>
          </div>

          <div className="flex items-center gap-4">
            <dl className="hidden items-center gap-4 text-xs sm:flex">
              <div className="text-right">
                <dt className="text-muted-foreground">Rol</dt>
                <dd className="font-medium">{ROLE_LABEL[session.role]}</dd>
              </div>
              <div className="text-right">
                <dt className="text-muted-foreground">Código público</dt>
                <dd className="font-mono font-medium">{session.publicCode}</dd>
              </div>
            </dl>

            <form action={logoutAction}>
              <Button type="submit" variant="outline">
                Cerrar sesión
              </Button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <dl className="grid gap-4 sm:grid-cols-3">
          <Fact label="Nombre" value={session.fullName} />
          <Fact label="Rol" value={ROLE_LABEL[session.role]} />
          <Fact label="Código público" value={session.publicCode} mono />
        </dl>

        {children}
      </div>
    </main>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}