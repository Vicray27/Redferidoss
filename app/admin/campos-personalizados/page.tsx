import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";
import { createCustomFieldsAdminService } from "@/lib/custom-fields-admin";
import { prisma } from "@/lib/db";

import { CustomFieldsManager } from "./custom-fields-manager";

// =============================================================================
// app/admin/campos-personalizados/page.tsx — §8.5: the custom fields CRUD.
//
// Thin face over `createCustomFieldsAdminService` (D56): read every definition
// and hand it to the client manager, which groups them by entity and previews
// each form with the same renderer the member forms use. The service re-checks
// the staff role, so the page guard is convenience, not the boundary.
// =============================================================================

export const dynamic = "force-dynamic";

export default async function CustomFieldsPage() {
  const session = await requireStaffSession("/admin/campos-personalizados");
  const fields = await createCustomFieldsAdminService(prisma).list({
    id: session.userId,
    role: session.role,
  });

  return (
    <SessionShell
      session={session}
      title="Campos personalizados"
      description="Define los datos extra que piden el registro y los reportes de pago: tipo, obligatoriedad, visibilidad y previsualización del formulario. Cada cambio queda auditado."
    >
      <CustomFieldsManager fields={fields} />
    </SessionShell>
  );
}
