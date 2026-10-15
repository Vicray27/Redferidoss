import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { createPaymentsService } from "@/lib/payments";
import { settings } from "@/lib/settings";

import { ReviewClient, type ReviewRow } from "./review-client";

// =============================================================================
// app/admin/revisiones/page.tsx — the §8.5 offering review queue.
//
// Pending reports of the current cycle, oldest first (the service orders
// them). Approving fulfils the week's obligation and notifies the member;
// rejecting demands a motive. Everything happens in
// reviewPaymentReportAction → lib/payments.ts; this page only reads.
// =============================================================================

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const session = await requireStaffSession("/admin/revisiones");
  const payments = createPaymentsService(prisma, settings);

  const queue = await payments.listReviewQueue({ limit: 50 });

  const rows: ReviewRow[] = queue.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    publicCode: row.publicCode,
    periodKey: row.periodKey,
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    note: row.note,
    proofKey: row.proofKey,
    paidAtLabel: dayLabel(row.paidAt),
    reportedAtLabel: dayLabel(row.reportedAt),
  }));

  return (
    <SessionShell
      session={session}
      title="Revisión de aportes"
      description="Aportes pendientes de esta semana. Aprobar cumple la obligación; rechazar pide un motivo."
    >
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          No hay aportes pendientes de revisión. Cuando alguien reporte el suyo,
          aparecerá aquí.
        </p>
      ) : (
        <ReviewClient rows={rows} />
      )}
    </SessionShell>
  );
}

/** `DD/MM/YYYY`, formatted on the server so SSR stays deterministic. */
function dayLabel(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}
