import { InvitePage } from "@/components/register/invite-page";

// The permanent referral link: /r/{public_code} (§8.2). Rendered per request —
// the page must reflect the sponsor's CURRENT quota, not a cached one.
export const dynamic = "force-dynamic";

export default async function ReferralPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <InvitePage slug={code} />;
}
