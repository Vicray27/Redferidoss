import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-bold tracking-tight">Red de Referidos — F1 Foundation</h1>
      <p className="max-w-xl text-center text-sm text-muted-foreground">
        Scaffold is up. Database migrations (PR2), Prisma client mirror (PR3), and seed plus
        runtime libraries (PR4) land in follow-up slices of this stack.
      </p>
      <div className="flex gap-3">
        <Button>Foundation OK</Button>
        <Button variant="outline">Portainer deploys on the server</Button>
      </div>
    </main>
  );
}
