import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { isStaffRole, landingPathForRole } from "@/lib/auth/guards";
import { getSession } from "@/lib/auth/require";
import { ROLE_LABELS } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

export default async function Home() {
  // Reading the cookie opts this page into dynamic rendering, so a signed-in
  // user sees their own landing instead of a login prompt.
  const session = await getSession();
  const landing = session ? landingPathForRole(session.role) : "/login";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-bold tracking-tight">Red de Referidos</h1>
      <p className="max-w-xl text-center text-sm text-muted-foreground">
        {session
          ? `Sesión activa como ${session.fullName} (${ROLE_LABELS[session.role] ?? session.role}).`
          : "Administra tu red, tus aportes y tu cumplimiento semanal."}
      </p>

      <div className="flex gap-3">
        {/* A link styled with buttonVariants, NOT a Link inside a Button:
            nesting an anchor in a button is invalid HTML and breaks keyboard
            activation. This is the shadcn idiom when Radix's asChild is absent. */}
        <Link href={landing} className={cn(buttonVariants())}>
          {session ? `Ir a ${landing}` : "Iniciar sesión"}
        </Link>
        {/* F5 shipped: the dashboard is real now, so the door is a link that
            only staff sees — members land in /portal, not here. */}
        {session && isStaffRole(session.role) ? (
          <Link href="/admin" className={cn(buttonVariants({ variant: "outline" }))}>
            Panel de administración
          </Link>
        ) : null}
      </div>
    </main>
  );
}
