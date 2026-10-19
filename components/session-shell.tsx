// =============================================================================
// components/session-shell.tsx — the frame every signed-in page renders inside.
//
// Desktop: a persistent left rail with the brand, the module menu and the
// identity/sign-out block, plus a full-width content column (no max-w). Mobile:
// a sticky top bar, a swipeable menu strip and the same content column.
//
// The menu lives in `SidebarNav` (a client component, because the active item
// follows `usePathname`). `NotificationBadge` stays a SERVER component here:
// it queries the database, so it is rendered by this server shell and never
// from inside the client menu.
//
// Extracting the identity block and the sign-out form keeps /admin and /portal
// from growing two copies of the same markup, which is how the two areas end
// up disagreeing about what a user sees.
// =============================================================================

import type { SessionPayload } from "@/lib/auth/session";
import { NotificationBadge } from "@/components/notification-badge";
import { SidebarNav } from "@/components/sidebar-nav";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";

const ROLE_LABEL: Record<SessionPayload["role"], string> = {
  ROOT: "Administrador raíz",
  ADMIN: "Administrador",
  MEMBER: "Referido",
};

export function SessionShell({
  session,
  title,
  description,
  children,
}: {
  session: SessionPayload;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-muted/40">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-background lg:flex">
        <div className="px-4 py-5">
          <p className="text-sm font-semibold tracking-tight">Red de Referidos</p>
          <p className="mt-1 text-xs text-muted-foreground">{ROLE_LABEL[session.role]}</p>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <SidebarNav role={session.role} variant="list" />
        </div>

        <div className="mt-auto space-y-3 border-t p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{session.fullName}</p>
            <p className="font-mono text-xs text-muted-foreground">{session.publicCode}</p>
            <p className="text-xs text-muted-foreground">{ROLE_LABEL[session.role]}</p>
          </div>

          <NotificationBadge session={session} />

          <form action={logoutAction}>
            <Button type="submit" variant="outline" className="w-full">
              Cerrar sesión
            </Button>
          </form>
        </div>
      </aside>

      <div className="w-full min-w-0 lg:pl-64">
        <header className="sticky top-0 z-40 border-b bg-background lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <p className="shrink-0 text-sm font-semibold tracking-tight">Red de Referidos</p>

            <div className="flex items-center gap-2">
              <NotificationBadge session={session} />

              <form action={logoutAction}>
                <Button type="submit" variant="outline" className="h-8 px-3 text-xs">
                  Cerrar sesión
                </Button>
              </form>
            </div>
          </div>
        </header>

        <div className="border-b bg-background lg:hidden">
          <SidebarNav role={session.role} variant="bar" />
        </div>

        <main className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}
