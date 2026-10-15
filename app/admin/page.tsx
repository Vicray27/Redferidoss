import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";

// =============================================================================
// app/admin/page.tsx — the back office landing for ROOT and ADMIN.
//
// This page is the AUTHORITY for access, not middleware.ts:
// `requireStaffSession` re-reads and re-verifies the cookie on the server and
// redirects if the session is missing or the role is not staff. Removing the
// middleware would cost a redirect; removing THIS would expose /admin.
//
// What renders here is deliberately minimal. F2 proves that a user can enter
// the system and that the right people land in the right area; the dashboard
// itself is F5.
// =============================================================================

export default async function AdminPage() {
  const session = await requireStaffSession("/admin");

  return (
    <SessionShell
      session={session}
      title="Administración"
      description="Zona reservada a ROOT y ADMIN. El panel completo llega en F5."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <NavCard
          href="/admin/revisiones"
          title="Revisión de aportes"
          description="Aprueba o rechaza los aportes reportados de la semana."
        />
        <NavCard
          href="/admin/configuracion"
          title="Configuración"
          description="Ajustes del sistema con auditoría de cada cambio."
        />
      </div>

      <section className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        El panel completo (referidos, métricas, exportes) llega en F5.
      </section>
    </SessionShell>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border bg-background p-5 text-sm transition-colors hover:bg-muted/50"
    >
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-muted-foreground">{description}</p>
    </Link>
  );
}