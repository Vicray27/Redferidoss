// =============================================================================
// app/api/network/search/route.ts — find people in the network by name or code.
//
// Same scope rules as the tree: a MEMBER searches their own subtree, staff
// searches everything (§7.1). An empty or whitespace-only term returns an
// empty list WITHOUT touching the database, so a keystroke-by-keystroke UI
// does not become a query storm.
// =============================================================================

import { z } from "zod";

import { okResponse, parseQuery, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { createNetworkService } from "@/lib/network";
import { settings } from "@/lib/settings";

const querySchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const { q, limit } = parseQuery(request, querySchema);

    const network = createNetworkService(prisma, authorization, settings);
    const results = await network.search(session, q, { limit });

    return okResponse({ query: q, results });
  });
}
