import Link from "next/link";

import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { createInvitationsService } from "@/lib/invitations";
import { createNetworkService } from "@/lib/network";
import { settings } from "@/lib/settings";

// =============================================================================
// app/portal/page.tsx — the member-facing landing (§8.4 "Inicio").
//
// `requireSession`, not `requireStaffSession`: every authenticated role may
// open /portal, including ROOT and ADMIN. They are simply not SENT here —
// `landingPathForRole` routes them to /admin after login. Refusing them would
// break a bookmark or a shared link to a page they are entitled to read.
//
// The cards are the §8.4 ones that F3 can answer honestly: remaining quota,
// network size and direct referrals. The weekly payment status needs the
// payments domain and arrives with F4 — a placeholder that says so is better
// than a number nobody has computed.
// =============================================================================

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  const session = await requireSession("/portal");

  const network = createNetworkService(prisma, authorization, settings);
  const invitations = createInvitationsService(prisma, settings);

  const [self, size, quota] = await Promise.all([
    network.node(session, session.userId),
    network.subtreeSize(session),
    invitations.quotaFor(session.userId),
  ]);

  return (
    <SessionShell
      session={session}
      title="Portal de referidos"
      description="Tu red, tus invitaciones, tu semana y tus aportes."
    >
      <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label="Cupos disponibles" value={`${quota.left} de ${quota.max}`} />
        <Stat label="Tamaño de mi red" value={String(size)} />
        <Stat label="Referidos directos" value={String(self.childrenCount)} />
      </dl>

      <div className="grid gap-4 sm:grid-cols-3">
        <NavCard
          href="/portal/network"
          title="Mi red"
          description="Árbol de referidos, búsqueda y fichas de las personas de tu red."
        />
        <NavCard
          href="/portal/invitations"
          title="Invitaciones"
          description="Tu link permanente, invitaciones de un solo uso y cupos."
        />
        <NavCard
          href="/portal/semana"
          title="Semana y aportes"
          description="Reporte de la Visión Celular, el aporte de esta semana y tu historial."
        />
      </div>
    </SessionShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
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
