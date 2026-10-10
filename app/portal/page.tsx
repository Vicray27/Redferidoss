import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";

// =============================================================================
// app/portal/page.tsx — the member-facing landing.
//
// `requireSession`, not `requireStaffSession`: every authenticated role may
// open /portal, including ROOT and ADMIN. They are simply not SENT here —
// `landingPathForRole` routes them to /admin after login. Refusing them would
// break a bookmark or a shared link to a page they are entitled to read.
//
// As in /admin, this server-side check is the authority; middleware only
// redirects.
// =============================================================================

export default async function PortalPage() {
  const session = await requireSession("/portal");

  return (
    <SessionShell
      session={session}
      title="Portal de referidos"
      description="Tu código público, tu rol y el estado de tu sesión. El contenido llega en F5."
    >
      <section className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        Sesión verificada en el servidor. Aquí aparecerán tus referidos y tus
        pagos cuando se implemente el portal completo (F5).
      </section>
    </SessionShell>
  );
}