// =============================================================================
// app/portal/network/[id]/page.tsx — the person file (§8.4).
//
// Access is decided by `assertCanViewUser` inside the service (§7.1): a node
// outside the caller's reach throws, and this page renders "sin acceso" for a
// Forbidden and a 404 for a missing row — the same distinction the guard
// itself makes, no more.
//
// Contact data and custom field values come back only when the viewer is
// staff or the person themself; the service already applied that rule, so this
// page renders what it received instead of deciding who deserves what.
//
// F4/D40: for a MEMBER viewing somebody else's file, this page is the person,
// not their subtree — no children count, no network size, no referral link and
// no tree. The service already scoped the data; hiding the blocks here is what
// keeps a truthful "0" from rendering as if it were a fact.
// =============================================================================

import Link from "next/link";
import { notFound } from "next/navigation";

import { LinkBox } from "@/components/link-box";
import { NetworkTree } from "@/components/network/network-tree";
import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { ForbiddenError, authorization, isStaffActor } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { createNetworkService } from "@/lib/network";
import { settings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function NetworkNodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession(`/portal/network/${id}`);
  const network = createNetworkService(prisma, authorization, settings);

  let detail;
  try {
    detail = await network.node(session, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) {
      return (
        <SessionShell
          session={session}
          title="Sin acceso"
          description="Esta ficha está fuera de tu red visible."
        >
          <p className="text-sm text-muted-foreground">
            Solo puedes ver las fichas de las personas de tu red.{" "}
            <Link className="underline" href="/portal/network">
              Volver a mi red
            </Link>
            .
          </p>
        </SessionShell>
      );
    }
    throw error;
  }

  const [chain, subtree, customs, firstPage] = await Promise.all([
    network.breadcrumb(session, id),
    network.subtreeSize(session, id),
    network.customValues(session, id),
    network.listChildren(session, { parentId: id }),
  ]);

  const joined = detail.joinedAt.slice(0, 10);

  // D40: counts, the referral link and the subtree belong to the person and to
  // staff; a member browsing a direct invitee sees identity and registration.
  const showsSubtree = isStaffActor(session) || session.userId === detail.id;

  return (
    <SessionShell
      session={session}
      title={detail.fullName}
      description={`Ficha de ${detail.publicCode} en tu red.`}
    >
      <nav aria-label="Ruta en el árbol" className="flex flex-wrap items-center gap-1 text-sm">
        {chain.map((node, index) => (
          <span key={node.id} className="flex items-center gap-1">
            {index > 0 ? <span className="text-muted-foreground">/</span> : null}
            {node.id === detail.id ? (
              <span className="font-medium">{node.fullName}</span>
            ) : (
              <Link className="underline" href={`/portal/network/${node.id}`}>
                {node.fullName}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <dl className="grid gap-4 sm:grid-cols-3">
        <Fact label="Código público" value={detail.publicCode} mono />
        <Fact label="Estado" value={detail.status} />
        <Fact label="Nivel" value={String(detail.depth)} />
        <Fact label="Registro" value={joined} />
        {showsSubtree ? (
          <Fact label="Referidos directos" value={String(detail.childrenCount)} />
        ) : null}
        {showsSubtree ? <Fact label="Tamaño de su red" value={String(subtree)} /> : null}
      </dl>

      {detail.sponsor ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Patrocinador: </span>
          <Link className="underline" href={`/portal/network/${detail.sponsor.id}`}>
            {detail.sponsor.fullName}
          </Link>{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {detail.sponsor.publicCode}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Sin patrocinador (raíz de la red).</p>
      )}

      {detail.contact ? (
        <section className="space-y-2 rounded-lg border bg-background p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Contacto
          </h2>
          <p className="text-sm">{detail.contact.email ?? "Sin correo visible"}</p>
          <p className="text-sm">{detail.contact.phone ?? "Sin teléfono visible"}</p>
        </section>
      ) : null}

      {customs.length > 0 ? (
        <section className="space-y-2 rounded-lg border bg-background p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Campos personalizados
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {customs.map((entry) => (
              <div key={entry.label}>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {entry.label}
                </dt>
                <dd className="text-sm">{formatCustomValue(entry.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {showsSubtree ? (
        <section className="space-y-3 rounded-lg border bg-background p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Su link de red
          </h2>
          <LinkBox
            path={`/r/${detail.publicCode}`}
            note={`Este es el link con el que ${detail.fullName} invita a sus propios referidos.`}
          />
        </section>
      ) : null}

      {showsSubtree ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Su subárbol</h2>
          <NetworkTree
            rootId={detail.id}
            rootDepth={detail.depth}
            initialChildren={firstPage.nodes}
            initialNextCursor={firstPage.nextCursor}
          />
        </section>
      ) : null}

      {showsSubtree ? (
        <p className="text-xs text-muted-foreground">
          El historial de pagos de esta persona llegará con la fase de pagos.
        </p>
      ) : null}
    </SessionShell>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function formatCustomValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
