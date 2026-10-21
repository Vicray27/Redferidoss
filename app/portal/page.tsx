import { redirect } from "next/navigation";

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
// `requireSession`, not `requireStaffSession`: ADMIN may open /portal through
// the staff cross-link. ROOT is different: it is the developer/system account,
// not a member, so app/portal/layout.tsx redirects it to /admin.
//
// The cards are the §8.4 ones that F3 can answer honestly: remaining quota,
// network size and direct referrals. The weekly payment status needs the
// payments domain and arrives with F4 — a placeholder that says so is better
// than a number nobody has computed.
// =============================================================================

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  const session = await requireSession("/portal");
  if (session.role === "ROOT") redirect("/admin");

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
