"use client";

// =============================================================================
// app/admin/pagos/payments-table.tsx — the §8.5 master table plus its bulk
// toolbar (review in bulk, reassign cycle, export the selection).
//
// The selection lives HERE, in one client component that owns the checkboxes
// and the toolbar together: a toolbar in another component would need shared
// state across the server boundary for no benefit. Every action calls the same
// Server Actions the individual review uses (D52) — this file owns zero
// business rules, only the confirm/prompt UX around them.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, buttonVariants } from "@/components/ui/button";
import { bulkReviewPaymentsAction, reassignPaymentsAction } from "@/lib/payments-actions";
import type { PaymentsExportField } from "@/lib/payments-admin";
import { cn } from "@/lib/utils";

export interface PaymentsTableRow {
  id: string;
  periodKey: string;
  paidAtLabel: string;
  reportedAtLabel: string;
  userId: string;
  userName: string;
  userCode: string;
  level: number;
  sponsorName: string | null;
  amount: string;
  currency: string;
  method: string | null;
  reference: string | null;
  /** Spanish label, resolved on the server from PAYMENT_STATUS_LABELS. */
  statusLabel: string;
  proofKey: string | null;
  reviewedByName: string | null;
  reviewedAtLabel: string | null;
  reviewNote: string | null;
  /** Already formatted values, one per dashboard custom field, same order. */
  customCells: string[];
}

export interface CycleChoice {
  id: string;
  periodKey: string;
}

const DASH = "—";

export function PaymentsTable({
  rows,
  cycles,
  customFields,
}: {
  rows: PaymentsTableRow[];
  cycles: CycleChoice[];
  /** Dashboard-visible fields: header per extra column (D57). */
  customFields: PaymentsExportField[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targetCycleId, setTargetCycleId] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const selectedIds = rows.filter((row) => selected.has(row.id)).map((row) => row.id);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const busy = pending;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runReview = (decision: "APPROVED" | "REJECTED", note: string | null) => {
    setMessage(null);
    startTransition(async () => {
      const result = await bulkReviewPaymentsAction({ reportIds: selectedIds, decision, note });
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo revisar la selección." });
        return;
      }
      setMessage({ kind: "ok", text: result.summary ?? "Listo." });
      setSelected(new Set());
      router.refresh();
    });
  };

  const onApprove = () => {
    if (!window.confirm(`¿Aprobar ${selectedIds.length} aportes seleccionados?`)) return;
    runReview("APPROVED", null);
  };

  const onReject = () => {
    const motive = window.prompt(
      `Motivo del rechazo para los ${selectedIds.length} aportes seleccionados (lo verá cada persona):`,
    );
    if (motive === null) return;
    if (motive.trim() === "") {
      setMessage({ kind: "error", text: "El rechazo necesita un motivo." });
      return;
    }
    runReview("REJECTED", motive.trim());
  };

  const onReassign = () => {
    const target = cycles.find((cycle) => cycle.id === targetCycleId);
    if (!target) return;
    if (
      !window.confirm(
        `¿Mover los reportes PENDIENTES seleccionados (${selectedIds.length}) a la semana ${target.periodKey}? Los que ya fueron revisados se omiten.`,
      )
    ) {
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await reassignPaymentsAction({ reportIds: selectedIds, targetCycleId });
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo reasignar la selección." });
        return;
      }
      setMessage({ kind: "ok", text: result.summary ?? "Listo." });
      setSelected(new Set());
      router.refresh();
    });
  };

  const selectionQuery = selectedIds.join(",");

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

      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {selectedIds.length > 0 ? `${selectedIds.length} seleccionados` : "Ninguno seleccionado"}
        </span>

        {selectedIds.length > 0 ? (
          <>
            <Button type="button" onClick={onApprove} disabled={busy} className="h-8 px-3">
              Aprobar selección
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onReject}
              disabled={busy}
              className="h-8 px-3"
            >
              Rechazar con motivo
            </Button>

            <span className="flex items-center gap-1">
              <select
                value={targetCycleId}
                onChange={(event) => setTargetCycleId(event.target.value)}
                aria-label="Semana destino para la reasignación"
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">Semana destino…</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {cycle.periodKey}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                onClick={onReassign}
                disabled={busy || targetCycleId === ""}
                className="h-8 px-3"
              >
                Reasignar
              </Button>
            </span>

            <span className="flex items-center gap-1">
              <a
                href={`/api/payments/export?ids=${encodeURIComponent(selectionQuery)}&format=xlsx`}
                className={cn(buttonVariants({ variant: "outline" }), "h-8 px-3")}
              >
                Exportar selección (.xlsx)
              </a>
              <a
                href={`/api/payments/export?ids=${encodeURIComponent(selectionQuery)}&format=csv`}
                className={cn(buttonVariants({ variant: "outline" }), "h-8 px-3")}
              >
                (.csv)
              </a>
            </span>
          </>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-background">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Seleccionar los pagos de esta página"
                />
              </th>
              <th className="px-3 py-3 font-medium">Semana</th>
              <th className="px-3 py-3 font-medium">Fechas</th>
              <th className="px-3 py-3 font-medium">Usuario</th>
              <th className="px-3 py-3 font-medium">Nivel</th>
              <th className="px-3 py-3 font-medium">Patrocinador</th>
              <th className="px-3 py-3 font-medium">Monto</th>
              <th className="px-3 py-3 font-medium">Método</th>
              <th className="px-3 py-3 font-medium">Referencia</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 font-medium">Comprobante</th>
              <th className="px-3 py-3 font-medium">Revisión</th>
              {customFields.map((field) => (
                <th key={field.code} className="px-3 py-3 font-medium">
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b align-top last:border-0">
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggleOne(row.id)}
                    aria-label={`Seleccionar el aporte de ${row.userName}`}
                  />
                </td>
                <td className="px-3 py-3">{row.periodKey}</td>
                <td className="px-3 py-3 text-xs">
                  <span className="block">Pago: {row.paidAtLabel}</span>
                  <span className="block text-muted-foreground">Reporte: {row.reportedAtLabel}</span>
                </td>
                <td className="px-3 py-3">
                  <a href={`/portal/network/${row.userId}`} className="font-medium underline">
                    {row.userName}
                  </a>
                  <span className="block font-mono text-xs text-muted-foreground">{row.userCode}</span>
                </td>
                <td className="px-3 py-3">{row.level}</td>
                <td className="px-3 py-3">{row.sponsorName ?? DASH}</td>
                <td className="px-3 py-3">
                  {row.amount} {row.currency}
                </td>
                <td className="px-3 py-3">{row.method ?? DASH}</td>
                <td className="px-3 py-3">{row.reference ?? DASH}</td>
                <td className="px-3 py-3">{row.statusLabel}</td>
                <td className="px-3 py-3">
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
                    DASH
                  )}
                </td>
                <td className="px-3 py-3 text-xs">
                  {row.reviewedByName ? (
                    <>
                      <span className="block">{row.reviewedByName}</span>
                      <span className="block text-muted-foreground">{row.reviewedAtLabel}</span>
                    </>
                  ) : (
                    <span className="block text-muted-foreground">Sin revisar</span>
                  )}
                  {row.reviewNote ? (
                    <span className="mt-1 block max-w-56 truncate text-muted-foreground" title={row.reviewNote}>
                      Nota: {row.reviewNote}
                    </span>
                  ) : null}
                </td>
                {row.customCells.map((cell, index) => (
                  <td key={customFields[index]?.code ?? index} className="px-3 py-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
