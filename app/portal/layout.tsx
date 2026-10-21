import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { requireSession } from "@/lib/auth/require";

// The system ROOT is the developer account, not a member: it has no business
// in the member portal. ADMIN may still open /portal (staff cross-link), but
// ROOT is always sent to the admin panel.
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requireSession("/portal");
  if (session.role === "ROOT") redirect("/admin");
  return children;
}
