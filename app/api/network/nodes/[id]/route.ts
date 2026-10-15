// =============================================================================
// app/api/network/nodes/[id]/route.ts — one node plus its breadcrumb trail.
//
// Both reads go through the same service and therefore the same scope decision
// (§7.1): a node outside the caller's reach is a 404, indistinguishable from a
// nonexistent one — that indistinguishability is the point.
//
// Contact data (email/phone) is included only for staff or the user themself;
// the service decides, not this route.
// =============================================================================

import { z } from "zod";

import { okResponse, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { ValidationError, fieldErrorsFrom } from "@/lib/errors";
import { createNetworkService } from "@/lib/network";

const paramsSchema = z.object({
  id: z.uuid("El identificador no es válido"),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();

    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) {
      throw new ValidationError("Parámetros inválidos.", fieldErrorsFrom(parsed.error.issues));
    }

    const network = createNetworkService(prisma, authorization);
    const [node, breadcrumb] = await Promise.all([
      network.node(session, parsed.data.id),
      network.breadcrumb(session, parsed.data.id),
    ]);

    return okResponse({ node, breadcrumb });
  });
}
