"use client";

// =============================================================================
// app/admin/revisiones/review-client.tsx — approve/reject buttons for the
// pending queue.
//
// Rejection opens `window.prompt` for the motive: the service REFUSES a
// rejection without one (it is what the member reads, and what the audit
// trail keeps), so the form cannot pretend the note is optional. Approve is a
// single click — the common case — and the server still owns every rule.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { reviewPaymentReportAction } from "@/lib/payments-actions";

export interface ReviewRow {
  id: string;
  fullName: string;
  publicCode: string;
  periodKey: string;
  amount: string;
  currency: string;
  method: string;
  reference: string | null;
  note: string | null;
  proofKey: string | null;
  paidAtLabel: string;
  reportedAtLabel: string;
  /** Already formatted label: value pairs (D56); empty values are dropped. */
  customValues: Array<{ label: string; value: string }>;
}

export function ReviewClient({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const run = (reportId: string, decision: "APPROVED" | "REJECTED", note: string | null) => {
    setMessage(null);
    setBusyId(reportId);

    startTransition(async () => {
      const result = await reviewPaymentReportAction({ reportId, decision, note });
      setBusyId(null);

      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo revisar el aporte." });
        return;
      }

      setMessage({
        kind: "ok",
        text: decision === "APPROVED" ? "Aporte aprobado." : "Aporte rechazado.",
      });
      router.refresh();
    });
  };

  const onApprove = (row: ReviewRow) => {
    if (!window.confirm(`¿Aprobar el aporte de ${row.fullName}?`)) return;
    run(row.id, "APPROVED", null);
  };

  const onReject = (row: ReviewRow) => {
    const motive = window.prompt(
      `Motivo del rechazo del aporte de ${row.fullName} (lo verá la persona):`,
    );
    if (motive === null) return;
    if (motive.trim() === "") {
      setMessage({ kind: "error", text: "El rechazo necesita un motivo." });
      return;
    }
    run(row.id, "REJECTED", motive.trim());
  };

  return (
    <div className="space-y-3">
      {message ? (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-foreground" : "text-destructive"}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border bg-background">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Persona</th>
              <th className="px-4 py-3 font-medium">Semana</th>
              <th className="px-4 py-3 font-medium">Monto</th>
              <th className="px-4 py-3 font-medium">Método</th>
              <th className="px-4 py-3 font-medium">Referencia</th>
              <th className="px-4 py-3 font-medium">Comprobante</th>
              <th className="px-4 py-3 font-medium">Reportado</th>
              <th className="px-4 py-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="px-4 py-3">
                  <span className="font-medium">{row.fullName}</span>
                  <span className="block text-xs text-muted-foreground">{row.publicCode}</span>
                  {row.note ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Nota: {row.note}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">{row.periodKey}</td>
                <td className="px-4 py-3">
                  {row.amount} {row.currency}
                  <span className="block text-xs text-muted-foreground">
                    Pagado el {row.paidAtLabel}
                  </span>
                </td>
                <td className="px-4 py-3">{row.method}</td>
                <td className="px-4 py-3">
                  {row.reference ?? "—"}
                  {row.customValues.length > 0 ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {row.customValues.map((entry) => (
                        <span key={entry.label} className="block">
                          {entry.label}: {entry.value}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  {row.proofKey ? (
                    <a
                      href={`/api/files/${row.proofKey}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Ver
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{row.reportedAtLabel}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      disabled={busy && busyId === row.id}
                      onClick={() => onApprove(row)}
                      className="h-8 px-3"
                    >
                      Aprobar
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy && busyId === row.id}
                      onClick={() => onReject(row)}
                      className="h-8 px-3"
                    >
                      Rechazar
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
