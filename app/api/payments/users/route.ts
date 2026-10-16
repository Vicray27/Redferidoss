// =============================================================================
// app/api/payments/users/route.ts — §8.5 filter #4: autocomplete the person
// filter of the master payments table.
//
// Staff-only, and it re-uses `dashboard.searchUsers` (D50's shared read) so the
// picker, the payments filter and the dashboard all resolve people the same
// way. An empty term returns an empty list WITHOUT touching the database: the
// UI queries on submit, not on every keystroke (no query storm).
// =============================================================================

import { z } from "zod";

import { okResponse, parseQuery, requireApiSession, withApi } from "@/lib/api";
import { authorization } from "@/lib/authz";
import { createDashboardService } from "@/lib/dashboard";
import { prisma } from "@/lib/db";

const querySchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    const { q, limit } = parseQuery(request, querySchema);

    const dashboard = createDashboardService(prisma, authorization);
    const results = await dashboard.searchUsers(session, q, { limit });

    return okResponse({ query: q, results });
  });
}
