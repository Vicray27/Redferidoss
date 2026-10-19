"use client";

// =============================================================================
// app/portal/invitations/invitations-client.tsx — the §8.2 invitation panel.
//
// The server page ships numbers and rows; every MUTATION goes through a Server
// Action (lib/invitations-actions.ts) and then `router.refresh()` re-reads the
// server component. There is deliberately no optimistic "Add" to the pending
// table: the quota arithmetic (R3) is the server's, and a client guess could
// show a slot that the next request refuses.
//
// Absolute links are built from `window.location.origin` AFTER mount, so the
// QR and the copy button always carry the same origin the visitor is using.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { LinkBox } from "@/components/link-box";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui/form";
import {
  createInvitationAction,
  revokeInvitationAction,
} from "@/lib/invitations-actions";

export interface PendingRow {
  id: string;
  kind: string;
  emailTarget: string | null;
  uses: number;
  maxUses: number;
  /** `YYYY-MM-DD`, formatted on the server to keep SSR and hydration identical. */
  createdDate: string;
  expiresDate: string | null;
}

export function InvitationsClient({
  publicCode,
  quota,
  pending,
  allowMultiUse,
}: {
  publicCode: string;
  quota: { max: number; used: number; left: number; children: number; pending: number };
  pending: PendingRow[];
  allowMultiUse: boolean;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [emailTarget, setEmailTarget] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");
  const [lastCreatedPath, setLastCreatedPath] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const onCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    startTransition(async () => {
      const result = await createInvitationAction({
        emailTarget,
        expiresInHours: expiresInHours.trim() === "" ? null : Number(expiresInHours),
      });

      if (!result.ok || !result.link) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo crear la invitación." });
        return;
      }

      setLastCreatedPath(result.link);
      setEmailTarget("");
      setExpiresInHours("");
      setMessage({ kind: "ok", text: "Invitación de un uso creada. Comparte el enlace o el QR." });
      router.refresh();
    });
  };

  const onRevoke = (id: string) => {
    if (!window.confirm("¿Revocar esta invitación? El enlace dejará de funcionar.")) return;
    setMessage(null);

    startTransition(async () => {
      const result = await revokeInvitationAction(id);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo revocar la invitación." });
        return;
      }
      setMessage({ kind: "ok", text: "Invitación revocada." });
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          aria-live={message.kind === "error" ? "assertive" : "polite"}
          className={
            message.kind === "error"
              ? "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              : "rounded-md border border-emerald-600/40 bg-emerald-50 p-3 text-sm text-emerald-800"
          }
        >
          {message.text}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Cupos de referidos</CardTitle>
          <CardDescription>
            {quota.children} referidos directos y {quota.pending} invitaciones pendientes
            cuentan contra tu límite.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <Metric label="Límite" value={String(quota.max)} />
            <Metric label="Usados" value={String(quota.used)} />
            <Metric label="Disponibles" value={String(quota.left)} strong />
          </div>
          {quota.left <= 0 ? (
            <p className="mt-4 text-sm text-destructive">
              No tienes cupos disponibles. Revoca una invitación pendiente o pide a
              tu patrocinador que amplíe tu límite.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mi enlace permanente</CardTitle>
          <CardDescription>
            Cualquier persona que lo use se registra como tu referido directo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {allowMultiUse ? (
            <LinkBox path={`/r/${publicCode}`} />
          ) : (
            <p className="text-sm text-muted-foreground">
              El enlace permanente está desactivado por configuración. Usa invitaciones
              de un solo uso.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invitación de un solo uso</CardTitle>
          <CardDescription>
            Se consume cuando la persona se registra. Ideal para compartir con una
            persona específica.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={onCreate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="emailTarget">Correo de la persona (opcional)</Label>
                <Input
                  id="emailTarget"
                  type="email"
                  placeholder="persona@dominio.com"
                  value={emailTarget}
                  disabled={busy || quota.left <= 0}
                  onChange={(event) => setEmailTarget(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiresInHours">Vigencia en horas (opcional)</Label>
                <Input
                  id="expiresInHours"
                  type="number"
                  min={0}
                  step={1}
                  placeholder="Según configuración"
                  value={expiresInHours}
                  disabled={busy || quota.left <= 0}
                  onChange={(event) => setExpiresInHours(event.target.value)}
                />
              </div>
            </div>

            <Button type="submit" disabled={busy || quota.left <= 0}>
              {busy ? "Creando…" : "Crear invitación"}
            </Button>
          </form>

          {lastCreatedPath ? (
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="mb-2 text-sm font-medium">Tu nueva invitación</p>
              <LinkBox path={lastCreatedPath} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invitaciones pendientes</CardTitle>
          <CardDescription>
            Aún no usadas. Las vencidas dejan de contar solas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay invitaciones pendientes.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">Dirigida a</th>
                    <th className="py-2 pr-4">Creada</th>
                    <th className="py-2 pr-4">Vence</th>
                    <th className="py-2 pr-4">Usos</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {pending.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-2 pr-4">{row.emailTarget ?? "Cualquier persona"}</td>
                      <td className="py-2 pr-4">{row.createdDate}</td>
                      <td className="py-2 pr-4">{row.expiresDate ?? "Sin vencimiento"}</td>
                      <td className="py-2 pr-4">
                        {row.uses} / {row.maxUses}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => onRevoke(row.id)}
                        >
                          Revocar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${strong ? "text-emerald-700" : ""}`}>{value}</p>
    </div>
  );
}
