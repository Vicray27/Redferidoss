// =============================================================================
// app/portal/network/page.tsx — "Mi red" (§8.4): the lazy tree + search.
//
// Three server reads in parallel: the actor's own node (depth + direct count),
// the first page of children, and the total subtree size. The tree component
// then takes over — every expansion is a scoped API call, never a client-side
// filter.
// =============================================================================

import { NetworkSearch } from "@/components/network/network-search";
import { NetworkTree } from "@/components/network/network-tree";
import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { createNetworkService } from "@/lib/network";
import { settings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  const session = await requireSession("/portal/network");

  const network = createNetworkService(prisma, authorization, settings);
  const [self, firstPage, size] = await Promise.all([
    network.node(session, session.userId),
    network.listChildren(session, {}),
    network.subtreeSize(session),
  ]);

  return (
    <SessionShell
      session={session}
      title="Mi red"
      description="Tu árbol de referidos. Cada nivel se carga al expandirlo."
    >
      <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label="Tamaño total de mi red" value={String(size)} />
        <Stat label="Referidos directos" value={String(self.childrenCount)} />
        <Stat label="Mi código" value={self.publicCode} mono />
      </dl>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Buscar</h2>
        <NetworkSearch />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Árbol</h2>
        <NetworkTree
          rootId={self.id}
          rootDepth={self.depth}
          initialChildren={firstPage.nodes}
          initialNextCursor={firstPage.nextCursor}
        />
      </section>

      <p className="text-xs text-muted-foreground">
        La vista de tabla con exportación llega con la siguiente fase.
      </p>
    </SessionShell>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
