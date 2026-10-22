"use client";

// =============================================================================
// app/portal/semana/payment-form.tsx — the member's offering report form.
//
// Two steps, by design (D29/D42): the proof file goes to POST /api/uploads
// first (Server Action bodies cap at ~1 MB), and only its returned `key`
// travels with the report action. The service re-checks window, amount mode
// and proof/reference requirements — this form validates only what a typo
// would break, never the business rules. Required fields are checked BEFORE
// the upload so an invalid submission does not leave an orphan file.
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

/** The PENDING/APPROVED report already filed for the current cycle. */
export interface LivePaymentReport {
  status: string;
  amount: string;
  currency: string;
  method: string;
  periodKey: string;
}

/** Fields the Server Action reports with these keys; everything else is custom. */
const BUILT_IN_ERROR_FIELDS = new Set(["amount", "paidAt", "reference", "proof", "methodId"]);

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendiente",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
};

export function PaymentForm({
  methods,
  fields,
  currency,
  amountMode,
  expectedAmount,
  editable,
  today,
  globalRequiresReference,
  globalRequiresProof,
  liveReport,
}: {
  methods: PaymentMethodOption[];
  /** Active PAYMENT_REPORT custom fields (F6/D56), rendered by the same renderer. */
  fields: RegistrationField[];
  currency: string | null;
  amountMode: string | null;
  expectedAmount: string | null;
  editable: boolean;
  /** Local date (YYYY-MM-DD) in `general.timezone`, never the browser's. */
  today: string;
  globalRequiresReference: boolean;
  globalRequiresProof: boolean;
  liveReport: LivePaymentReport | null;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
  // D43: reference is required when BOTH flags are true; proof when EITHER is.
  const referenceRequired = globalRequiresReference && (selectedMethod?.requiresReference ?? false);
  const proofRequired = globalRequiresProof || (selectedMethod?.requiresProof ?? false);

  const amountHint =
    expectedAmount && currency
      ? amountMode === "FIXED"
        ? `Monto esperado: ${expectedAmount} ${currency}.`
        : amountMode === "MINIMUM"
          ? `Monto mínimo: ${expectedAmount} ${currency}.`
          : null
      : null;

  const clearFieldError = (field: string) => {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const clearFile = () => {
    setFile(null);
    // Remounting the native input is the only way to clear its internal value.
    setFileInputKey((current) => current + 1);
    clearFieldError("proof");
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setCustomErrors({});

    // Validate before the upload step: an early return here is what keeps an
    // invalid submission from storing a proof nobody references.
    const errors: Record<string, string> = {};
    if (amount.trim() === "" || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      errors.amount = "Ingresa un monto mayor que cero.";
    }
    if (methodId === "") {
      errors.methodId = "Elige un método de pago.";
    }
    if (paidAt.trim() === "") {
      errors.paidAt = "Indica la fecha del pago.";
    } else if (paidAt > today) {
      errors.paidAt = "La fecha del pago no puede estar en el futuro.";
    }
    if (referenceRequired && reference.trim() === "") {
      errors.reference = "Ingresa la referencia del pago.";
    }
    if (proofRequired && file === null) {
      errors.proof = "Adjunta el comprobante.";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setMessage({ kind: "error", text: "Revisa los campos marcados." });
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
        setMessage({ kind: "error", text: result.message ?? "No se pudo enviar la ofrenda." });
        const inline: Record<string, string> = {};
        const custom: Record<string, string> = {};
        for (const [field, text] of Object.entries(result.fieldErrors ?? {})) {
          if (BUILT_IN_ERROR_FIELDS.has(field)) inline[field] = text;
          else custom[field] = text;
        }
        if (Object.keys(inline).length > 0) {
          setFieldErrors((current) => ({ ...current, ...inline }));
        }
        setCustomErrors(custom);
        return;
      }

      setMessage({
        kind: "ok",
        text: "Ofrenda enviada. Su estado queda en la lista de abajo.",
      });
      setAmount("");
      setReference("");
      setNote("");
      setFile(null);
      setFileInputKey((current) => current + 1);
      setFieldErrors({});
      setCustomErrors({});
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

  if (liveReport) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reportar mi ofrenda</CardTitle>
          <CardDescription>Ya registraste una ofrenda para esta semana.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Monto</dt>
              <dd className="font-medium">
                {liveReport.amount} {liveReport.currency}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Método</dt>
              <dd>{liveReport.method}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Estado</dt>
              <dd>{STATUS_LABELS[liveReport.status] ?? liveReport.status}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Semana</dt>
              <dd>{liveReport.periodKey}</dd>
            </div>
          </dl>
          {/* The post-submit confirmation survives the server refresh that
              replaces the form with this card; E2E asserts this exact text. */}
          {message ? (
            <p
              className={`mt-3 text-sm ${message.kind === "ok" ? "text-foreground" : "text-destructive"}`}
              role={message.kind === "error" ? "alert" : "status"}
            >
              {message.text}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (!editable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reportar mi ofrenda</CardTitle>
          <CardDescription>
            La ofrenda se reporta mientras la semana está abierta. Cuando abra el
            próximo ciclo vas a poder enviarla.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Reportar mi ofrenda</CardTitle>
        <CardDescription>
          Una ofrenda por semana. Si el equipo la rechaza dentro de la semana,
          puedes enviar una nueva.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pay-amount">Monto</Label>
              <Input
                id="pay-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                aria-invalid={fieldErrors.amount ? true : undefined}
                onChange={(event) => {
                  setAmount(event.target.value);
                  clearFieldError("amount");
                }}
              />
              {amountHint ? (
                <p className="text-xs text-muted-foreground">{amountHint}</p>
              ) : null}
              {fieldErrors.amount ? (
                <p className="text-xs text-destructive" role="alert">
                  {fieldErrors.amount}
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="pay-method">Método</Label>
              <select
                id="pay-method"
                value={methodId}
                aria-invalid={fieldErrors.methodId ? true : undefined}
                onChange={(event) => {
                  setMethodId(event.target.value);
                  // Requirements depend on the method: a previous reference or
                  // proof error may no longer apply after this change.
                  clearFieldError("methodId");
                  clearFieldError("reference");
                  clearFieldError("proof");
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base aria-[invalid=true]:border-destructive sm:text-sm"
              >
                {methods.length === 0 ? <option value="">Sin métodos activos</option> : null}
                {methods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label}
                  </option>
                ))}
              </select>
              {fieldErrors.methodId ? (
                <p className="text-xs text-destructive" role="alert">
                  {fieldErrors.methodId}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-reference">
              Referencia del pago
              {referenceRequired ? " (obligatoria para este método)" : " (opcional)"}
            </Label>
            <Input
              id="pay-reference"
              value={reference}
              aria-invalid={fieldErrors.reference ? true : undefined}
              onChange={(event) => {
                setReference(event.target.value);
                clearFieldError("reference");
              }}
              placeholder="Número de referencia o código de la transacción."
            />
            {fieldErrors.reference ? (
              <p className="text-xs text-destructive" role="alert">
                {fieldErrors.reference}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-date">Fecha del pago</Label>
            <Input
              id="pay-date"
              type="date"
              value={paidAt}
              max={today}
              aria-invalid={fieldErrors.paidAt ? true : undefined}
              onChange={(event) => {
                setPaidAt(event.target.value);
                clearFieldError("paidAt");
              }}
            />
            {fieldErrors.paidAt ? (
              <p className="text-xs text-destructive" role="alert">
                {fieldErrors.paidAt}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="pay-proof">
              Comprobante
              {proofRequired ? " (obligatorio)" : " (opcional)"}
            </Label>
            <input
              key={fileInputKey}
              id="pay-proof"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
              aria-invalid={fieldErrors.proof ? true : undefined}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                clearFieldError("proof");
              }}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            />
            {file ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={clearFile}
                  className="h-9 shrink-0 px-3"
                >
                  Quitar
                </Button>
              </div>
            ) : null}
            {fieldErrors.proof ? (
              <p className="text-xs text-destructive" role="alert">
                {fieldErrors.proof}
              </p>
            ) : null}
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
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground sm:text-sm"
            />
          </div>

          {fields.length > 0 ? (
            <div className="space-y-4 rounded-md border border-dashed p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Datos de la ofrenda
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

          <Button type="submit" disabled={busy} className="min-h-11 w-full sm:w-auto">
            {uploading ? "Subiendo comprobante…" : busy ? "Enviando…" : "Enviar ofrenda"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
