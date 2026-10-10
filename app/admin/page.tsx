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
      <section className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        Sesión verificada en el servidor. El panel de administración completo
        (referidos, pagos, ajustes) llega en F5.
      </section>
    </SessionShell>
  );
}