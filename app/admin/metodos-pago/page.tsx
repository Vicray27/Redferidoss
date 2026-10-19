import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { createPaymentMethodsAdminService } from "@/lib/payment-methods-admin";

import { MethodsManager } from "./methods-manager";

// =============================================================================
// app/admin/metodos-pago/page.tsx — §5.6/§8.5: the payment methods catalog.
//
// Thin face over `createPaymentMethodsAdminService` (D55): read the catalog
// and hand it to the client manager. The service re-checks the staff role, so
// the page guard is convenience, not the boundary.
// =============================================================================

export const dynamic = "force-dynamic";

export default async function PaymentMethodsPage() {
  const session = await requireStaffSession("/admin/metodos-pago");
  const methods = await createPaymentMethodsAdminService(prisma).list({
    id: session.userId,
    role: session.role,
  });

  return (
    <SessionShell
      session={session}
      title="Métodos de pago"
      description="Configura cómo aportan las personas: nombres visibles, instrucciones, requisitos de referencia y comprobante, posición y disponibilidad. Cada cambio queda auditado."
    >
      <MethodsManager methods={methods} />
    </SessionShell>
  );
}
