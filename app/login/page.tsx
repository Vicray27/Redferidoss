import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { landingPathForRole, safeNextPath } from "@/lib/auth/guards";
import { getSession } from "@/lib/auth/require";

// Server component. `getSession()` opts this page into dynamic rendering
// because it reads a cookie, so a signed-in user is never served a cached copy
// of the login form.
//
// middleware.ts already redirects an authenticated user away from /login. The
// check is repeated here for the same reason lib/auth/require.ts repeats it on
// the protected pages: the page must not depend on the matcher being right.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const session = await getSession();
  if (session) redirect(landingPathForRole(session.role));

  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;

  // Sanitised here as well as inside loginAction: `?next=` is attacker-supplied
  // input, and a page that renders it must not be the place it becomes trusted.
  const nextPath = safeNextPath(rawNext);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Red de Referidos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acceso al panel de administración y al portal de referidos.
          </p>
        </div>
        <LoginForm nextPath={nextPath} />
      </div>
    </main>
  );
}