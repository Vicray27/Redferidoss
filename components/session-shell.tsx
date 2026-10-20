// =============================================================================
// components/session-shell.tsx — the frame every signed-in page renders inside.
//
// Desktop: a persistent left rail with the brand, the module menu and the
// identity/sign-out block, plus a full-width content column (no max-w). Mobile:
// a sticky top bar with a hamburger that opens the same module menu in a
// left slide-over drawer and the same content column.
//
// The menu lives in `SidebarNav` (a client component, because the active item
// follows `usePathname`). `NotificationBadge` stays a SERVER component here:
// it queries the database, so it is rendered by this server shell and never
// from inside the client menu.
//
// The identity block and the sign-out form are built here as server-rendered
// slots for the mobile drawer: `NotificationBadge` and `logoutAction` stay on
// the server, and /admin and /portal do not grow two copies of the same markup.
// =============================================================================

import type { SessionPayload } from "@/lib/auth/session";
import { MobileMenu } from "@/components/mobile-menu";
import { NotificationBadge } from "@/components/notification-badge";
import { SidebarNav } from "@/components/sidebar-nav";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import { ROLE_LABELS } from "@/lib/ui-labels";

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
  const roleLabel = ROLE_LABELS[session.role] ?? session.role;

  // Server-rendered slots for the client drawer: the identity block and the
  // sign-out form keep their server actions and never cross the client menu.
  const identity = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{session.fullName}</p>
      <p className="truncate font-mono text-xs text-muted-foreground">{session.publicCode}</p>
    </div>
  );

  const signOut = (
    <form action={logoutAction}>
      <Button type="submit" variant="outline" className="w-full">
        Cerrar sesión
      </Button>
    </form>
  );

  return (
    <div className="min-h-screen bg-muted/40">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-background lg:flex">
        <div className="px-4 py-5">
          <p className="text-sm font-semibold tracking-tight">Red de Referidos</p>
          <p className="mt-1 text-xs text-muted-foreground">{ROLE_LABELS[session.role] ?? session.role}</p>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <SidebarNav role={session.role} variant="list" />
        </div>

        <div className="mt-auto space-y-3 border-t p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{session.fullName}</p>
            <p className="font-mono text-xs text-muted-foreground">{session.publicCode}</p>
            <p className="text-xs text-muted-foreground">{ROLE_LABELS[session.role] ?? session.role}</p>
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
        {/* One sticky block: the hamburger and the inbox stay visible while the page scrolls. */}
        <div className="sticky top-0 z-40 border-b bg-background lg:hidden print:hidden">
          <header className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <MobileMenu
                role={session.role}
                roleLabel={roleLabel}
                identity={identity}
                signOut={signOut}
              />

              <p className="min-w-0 truncate text-sm font-semibold tracking-tight">
                Red de Referidos
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <NotificationBadge session={session} />
            </div>
          </header>
        </div>

        <main className="w-full min-w-0 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
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
