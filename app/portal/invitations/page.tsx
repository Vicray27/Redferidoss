// =============================================================================
// app/portal/invitations/page.tsx — the server side of the invitation panel.
//
// Reads are direct service calls (no fetch round trip): this component runs on
// the server, already knows the session, and the service enforces the same
// rules the API routes do. Dates are formatted HERE, flattened to `YYYY-MM-DD`
// strings, so the client component's SSR pass and its hydration produce
// identical markup regardless of timezone.
// =============================================================================

import { SessionShell } from "@/components/session-shell";
import { requireSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { createInvitationsService } from "@/lib/invitations";
import { settings } from "@/lib/settings";

import { InvitationsClient, type PendingRow } from "./invitations-client";

// A quota that is one click stale is a wrong quota: never cache this page.
export const dynamic = "force-dynamic";

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export default async function InvitationsPage() {
  const session = await requireSession("/portal/invitations");

  const invitations = createInvitationsService(prisma, settings);
  const [quota, pending, allowMultiUse] = await Promise.all([
    invitations.quotaFor(session.userId),
    invitations.listPending(session.userId),
    settings.getOrThrow<boolean>("referral.allow_multi_use_link"),
  ]);

  const rows: PendingRow[] = pending.map((invitation) => ({
    id: invitation.id,
    kind: invitation.kind,
    emailTarget: invitation.emailTarget,
    uses: invitation.uses,
    maxUses: invitation.maxUses,
    createdDate: isoDate(invitation.createdAt) ?? "",
    expiresDate: isoDate(invitation.expiresAt),
  }));

  return (
    <SessionShell
      session={session}
      title="Invitaciones"
      description="Tu link de referido, invitaciones de un solo uso y cupos disponibles."
    >
      <InvitationsClient
        publicCode={session.publicCode}
        quota={{
          max: quota.max,
          used: quota.used,
          left: quota.left,
          children: quota.children,
          pending: quota.pending,
        }}
        pending={rows}
        allowMultiUse={allowMultiUse}
      />
    </SessionShell>
  );
}
