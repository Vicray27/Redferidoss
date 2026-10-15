import { InvitePage } from "@/components/register/invite-page";

// A single-use invitation token: /invite/{token} (§8.2). Force-dynamic for the
// same reason as /r/{code}: quota and token state are read fresh per request.
export const dynamic = "force-dynamic";

export default async function InviteTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InvitePage slug={token} />;
}
