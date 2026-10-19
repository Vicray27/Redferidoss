"use client";

// =============================================================================
// app/admin/revisiones/review-client.tsx — approve/reject buttons for the
// pending queue.
//
// Rejection opens the shared motive dialog: the service REFUSES a rejection
// without one (it is what the member reads, and what the audit trail keeps), so
// the form cannot pretend the note is optional. Approve asks for confirmation
// because it is irreversible from this screen; the server still owns every
// rule. Feedback goes to the root toast stack so it survives `router.refresh()`.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ConfirmDialog, MotiveDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { reviewPaymentReportAction } from "@/lib/payments-actions";

export interface ReviewRow {
  id: string;
  fullName: string;
  publicCode: string;
  periodKey: string;
  /** Friendly week range; `periodKey` stays as the raw `title` tooltip. */
  weekLabel: string;
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
  const toast = useToast();
  const [busy, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "approve"; row: ReviewRow } | { kind: "reject"; row: ReviewRow } | null
  >(null);

  const run = (row: ReviewRow, decision: "APPROVED" | "REJECTED", note: string | null) => {
    setBusyId(row.id);

    startTransition(async () => {
      const result = await reviewPaymentReportAction({ reportId: row.id, decision, note });
      setBusyId(null);
      setDialog(null);

      if (!result.ok) {
        toast.error(result.message ?? "No se pudo revisar el aporte.");
        return;
      }

      toast.success(decision === "APPROVED" ? "Aporte aprobado." : "Aporte rechazado.");
      router.refresh();
    });
  };

  const onApprove = (row: ReviewRow) => {
    setDialog({ kind: "approve", row });
  };

  const onReject = (row: ReviewRow) => {
    setDialog({ kind: "reject", row });
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
          No hay aportes pendientes de revisión. Cuando alguien reporte el suyo, aparecerá aquí.
        </p>
      ) : (
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
              <th className="px-4 py-3 font-medium">Fecha de reporte</th>
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
                <td className="px-4 py-3" title={row.periodKey}>
                  {row.weekLabel}
                </td>
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
                      Ver comprobante
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
      )}

      {dialog?.kind === "approve" ? (
        <ConfirmDialog
          open
          title={`¿Aprobar el aporte de ${dialog.row.fullName}?`}
          confirmLabel="Aprobar"
          busy={busy && busyId === dialog.row.id}
          onConfirm={() => run(dialog.row, "APPROVED", null)}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === "reject" ? (
        <MotiveDialog
          open
          title="Rechazar el aporte"
          description={`Motivo del rechazo del aporte de ${dialog.row.fullName}.`}
          busy={busy && busyId === dialog.row.id}
          onConfirm={(motive) => run(dialog.row, "REJECTED", motive)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
