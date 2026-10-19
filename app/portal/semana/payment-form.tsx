"use client";

// =============================================================================
// app/portal/semana/payment-form.tsx — the member's offering report form.
//
// Two steps, by design (D29/D42): the proof file goes to POST /api/uploads
// first (Server Action bodies cap at ~1 MB), and only its returned `key`
// travels with the report action. The service re-checks window, amount mode
// and proof/reference requirements — this form validates only what a typo
// would break.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { FieldRenderer } from "@/components/dynamic-form/field-renderer";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui/form";
import type { RegistrationField } from "@/lib/invitations";
import { submitPaymentReportAction } from "@/lib/payments-actions";

export interface PaymentMethodOption {
  id: string;
  code: string;
  label: string;
  requiresReference: boolean;
  requiresProof: boolean;
}

export function PaymentForm({
  methods,
  fields,
  currency,
  amountMode,
  expectedAmount,
  editable,
}: {
  methods: PaymentMethodOption[];
  /** Active PAYMENT_REPORT custom fields (F6/D56), rendered by the same renderer. */
  fields: RegistrationField[];
  currency: string | null;
  amountMode: string | null;
  expectedAmount: string | null;
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  // The admin-defined defaults PREFILL the form (D56); the server still
  // validates whatever is submitted, defaults included.
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields
        .filter(
          (field) =>
            field.type !== "FILE" && field.defaultValue !== null && field.defaultValue !== undefined,
        )
        .map((field) => [field.code, field.defaultValue]),
    ),
  );
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});

  const selectedMethod = methods.find((method) => method.id === methodId) ?? null;

  const amountHint =
    expectedAmount && currency
      ? amountMode === "FIXED"
        ? `Monto esperado: ${expectedAmount} ${currency}.`
        : amountMode === "MINIMUM"
          ? `Monto mínimo: ${expectedAmount} ${currency}.`
          : null
      : null;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setCustomErrors({});

    if (amount.trim() === "" || Number(amount) <= 0) {
      setMessage({ kind: "error", text: "Ingresa el monto del aporte." });
      return;
    }
    if (methodId === "") {
      setMessage({ kind: "error", text: "Elige un método de pago." });
      return;
    }

    startTransition(async () => {
      let proofKey: string | null = null;

      if (file) {
        setUploading(true);
        try {
          const body = new FormData();
          body.append("file", file);
          const response = await fetch("/api/uploads", { method: "POST", body });
          const payload = (await response.json().catch(() => null)) as
            | {
                ok?: boolean;
                data?: { key?: string };
                error?: { message?: string };
              }
            | null;

          if (!response.ok || payload?.ok !== true || !payload.data?.key) {
            setMessage({
              kind: "error",
              text: payload?.error?.message ?? "No se pudo subir el comprobante.",
            });
            return;
          }
          proofKey = payload.data.key;
        } finally {
          setUploading(false);
        }
      }

      const result = await submitPaymentReportAction({
        amount,
        methodId,
        reference: reference.trim() === "" ? null : reference,
        paidAt,
        note: note.trim() === "" ? null : note,
        proofKey,
        custom: fields.length > 0 ? customValues : null,
      });

      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo enviar el aporte." });
        setCustomErrors(result.fieldErrors ?? {});
        return;
      }

      setMessage({
        kind: "ok",
        text: "Aporte enviado. Su estado queda en la lista de abajo.",
      });
      setAmount("");
      setReference("");
      setNote("");
      setFile(null);
      // Back to the admin defaults, exactly like a fresh page load.
      setCustomValues(
        Object.fromEntries(
          fields
            .filter(
              (field) =>
                field.type !== "FILE" &&
                field.defaultValue !== null &&
                field.defaultValue !== undefined,
            )
            .map((field) => [field.code, field.defaultValue]),
        ),
      );
      router.refresh();
    });
  };

  if (!editable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reportar mi aporte</CardTitle>
          <CardDescription>
            El aporte se reporta mientras la semana está abierta. Cuando abra el
            próximo ciclo vas a poder enviarlo.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Reportar mi aporte</CardTitle>
        <CardDescription>
          Un aporte por semana. Si el equipo lo rechaza dentro de la semana,
          puedes enviar uno nuevo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="pay-amount">Monto</Label>
              <Input
                id="pay-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              {amountHint ? (
                <p className="text-xs text-muted-foreground">{amountHint}</p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="pay-method">Método</Label>
              <select
                id="pay-method"
                value={methodId}
                onChange={(event) => setMethodId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {methods.length === 0 ? <option value="">Sin métodos activos</option> : null}
                {methods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-reference">
              Referencia del pago
              {selectedMethod?.requiresReference ? " (obligatoria para este método)" : " (opcional)"}
            </Label>
            <Input
              id="pay-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Número de referencia o código de la transacción."
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-date">Fecha del pago</Label>
            <Input
              id="pay-date"
              type="date"
              value={paidAt}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setPaidAt(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-proof">
              Comprobante
              {selectedMethod?.requiresProof ? " (obligatorio para este método)" : " (opcional)"}
            </Label>
            <input
              id="pay-proof"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              JPG, PNG, WEBP o PDF, hasta 10 MB.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-note">Nota (opcional)</Label>
            <textarea
              id="pay-note"
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </div>

          {fields.length > 0 ? (
            <div className="space-y-4 rounded-md border border-dashed p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Datos del aporte
              </p>
              {fields.map((field) => (
                <FieldRenderer
                  key={field.code}
                  field={field}
                  value={customValues[field.code]}
                  error={customErrors[field.code]}
                  onChange={(next) =>
                    setCustomValues((current) => ({ ...current, [field.code]: next }))
                  }
                />
              ))}
            </div>
          ) : null}

          {message ? (
            <p
              className={`text-sm ${message.kind === "ok" ? "text-foreground" : "text-destructive"}`}
              role={message.kind === "error" ? "alert" : "status"}
            >
              {message.text}
            </p>
          ) : null}

          <Button type="submit" disabled={busy}>
            {uploading ? "Subiendo comprobante…" : busy ? "Enviando…" : "Enviar aporte"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
