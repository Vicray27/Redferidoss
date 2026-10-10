import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { landingPathForRole } from "@/lib/auth/guards";
import { getSession } from "@/lib/auth/require";
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
          ? `Sesión activa como ${session.fullName} (${session.role}).`
          : "Base ejecutable con migraciones, catálogo de settings y autenticación real."}
      </p>

      <div className="flex gap-3">
        {/* A link styled with buttonVariants, NOT a Link inside a Button:
            nesting an anchor in a button is invalid HTML and breaks keyboard
            activation. This is the shadcn idiom when Radix's asChild is absent. */}
        <Link href={landing} className={cn(buttonVariants())}>
          {session ? `Ir a ${landing}` : "Iniciar sesión"}
        </Link>
        <Button variant="outline" disabled>
          Panel completo en F5
        </Button>
      </div>
    </main>
  );
}
