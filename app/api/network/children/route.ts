// =============================================================================
// app/api/network/children/route.ts — direct children of a node, page by page.
//
// The portal tree loads lazily: one request per expanded node, with the scope
// filter applied server-side by the service (§7.1). `parentId` defaults to the
// caller's own node, which is what "mi red" means for a MEMBER.
// =============================================================================

import { z } from "zod";

import { okResponse, parseQuery, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { createNetworkService } from "@/lib/network";
import { settings } from "@/lib/settings";

const querySchema = z.object({
  parentId: z.uuid("El identificador no es válido").optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const query = parseQuery(request, querySchema);

    const network = createNetworkService(prisma, authorization, settings);
    const page = await network.listChildren(session, query);

    return okResponse(page);
  });
}
