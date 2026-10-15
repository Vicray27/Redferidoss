// =============================================================================
// app/api/public/invite/[slug]/route.ts — resolve an invitation link (§8.2).
//
// Public on purpose: the person holding the link has no account yet. What the
// response may contain is therefore decided narrowly — what the registration
// FORM needs and nothing else:
//
//   * sponsor identity (the invitee must know who invited them),
//   * remaining slots (so a full sponsor fails with a message, not a surprise),
//   * the custom field definitions to render,
//   * the kind (permanent link vs single-use token).
//
// `emailTarget` is deliberately ABSENT. It would let anyone holding a leaked
// link read the address the invitation was addressed to; the invitee knows
// their own mailbox, and a mismatch is enforced at registration time with the
// same generic conflict the rest of the flow uses.
//
// The slug is either an 8-char public code or a 43-char token; both are
// validated by the service (`resolveInvite` throws InviteInvalidError → 404).
// =============================================================================

import { clientIp, okResponse, withApi } from "@/lib/api";
import { createInvitationsService } from "@/lib/invitations";
import { prisma } from "@/lib/db";
import { publicInviteThrottle } from "@/lib/registration-deps";
import { settings } from "@/lib/settings";
import { RateLimitedError } from "@/lib/throttle";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return withApi(async () => {
    const rate = publicInviteThrottle.attempt(clientIp(request) ?? "unknown");
    if (!rate.allowed) throw new RateLimitedError();

    const { slug } = await context.params;
    const invitations = createInvitationsService(prisma, settings);
    const resolution = await invitations.resolveInvite(decodeURIComponent(slug));

    return okResponse({
      kind: resolution.kind,
      sponsor: {
        fullName: resolution.sponsor.fullName,
        publicCode: resolution.sponsor.publicCode,
      },
      slotsLeft: resolution.slots.left,
      fields: resolution.fields.map((field) => ({
        code: field.code,
        label: field.label,
        type: field.type,
        options: field.options,
        isRequired: field.isRequired,
        regex: field.regex,
        minNumeric: field.minNumeric,
        maxNumeric: field.maxNumeric,
        sortOrder: field.sortOrder,
      })),
    });
  });
}
