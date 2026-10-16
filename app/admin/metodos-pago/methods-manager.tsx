"use client";

// =============================================================================
// app/admin/metodos-pago/methods-manager.tsx — the catalog screen.
//
// One card creates a method; one row per method edits it in place. The row
// NEVER shows an input for `code`: it is immutable (D55), so the screen cannot
// even suggest otherwise. ↑/↓ reorder through the audited service action, and
// "Desactivar" is the retirement path — there is no delete (D55).
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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
import {
  createPaymentMethodAction,
  movePaymentMethodAction,
  updatePaymentMethodAction,
  type PaymentMethodActionResult,
} from "@/lib/payment-methods-actions";

export interface PaymentMethodItem {
  id: string;
  code: string;
  label: string;
  instructions: string | null;
  requiresReference: boolean;
  requiresProof: boolean;
  isActive: boolean;
  sortOrder: number;
}

interface Draft {
  label: string;
  instructions: string;
  requiresReference: boolean;
  requiresProof: boolean;
  sortOrder: string;
}

function draftFrom(method: PaymentMethodItem): Draft {
  return {
    label: method.label,
    instructions: method.instructions ?? "",
    requiresReference: method.requiresReference,
    requiresProof: method.requiresProof,
    sortOrder: String(method.sortOrder),
  };
}

export function MethodsManager({ methods }: { methods: PaymentMethodItem[] }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [newMethod, setNewMethod] = useState({
    code: "",
    label: "",
    instructions: "",
    requiresReference: true,
    requiresProof: false,
  });

  const run = (
    action: () => Promise<PaymentMethodActionResult>,
    okText: string,
    onSuccess?: () => void,
  ) => {
    setMessage(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo guardar el método de pago." });
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setMessage({ kind: "ok", text: result.message ?? okText });
      setEditingId(null);
      setDraft(null);
      onSuccess?.();
      router.refresh();
    });
  };

  const onCreate = () => {
    run(
      () =>
        createPaymentMethodAction({
          code: newMethod.code,
          label: newMethod.label,
          instructions: newMethod.instructions,
          requiresReference: newMethod.requiresReference,
          requiresProof: newMethod.requiresProof,
        }),
      "Método creado.",
      // Only clear the form once the server accepted it — an error must not
      // eat what the admin typed.
      () => setNewMethod({ code: "", label: "", instructions: "", requiresReference: true, requiresProof: false }),
    );
  };

  const onSaveRow = (method: PaymentMethodItem) => {
    if (draft === null) return;
    run(
      () =>
        updatePaymentMethodAction(method.id, {
          label: draft.label,
          instructions: draft.instructions,
          requiresReference: draft.requiresReference,
          requiresProof: draft.requiresProof,
          sortOrder: draft.sortOrder === "" ? undefined : Number(draft.sortOrder),
        }),
      `«${draft.label}» guardado.`,
    );
  };

  const onToggleActive = (method: PaymentMethodItem) => {
    run(
      () =>
        updatePaymentMethodAction(method.id, { isActive: !method.isActive }),
      method.isActive ? `«${method.label}» desactivado.` : `«${method.label}» activado.`,
    );
  };

  const onMove = (method: PaymentMethodItem, direction: "up" | "down") => {
    run(() => movePaymentMethodAction(method.id, direction), "Orden actualizado.");
  };

  return (
    <div className="space-y-6">
      {message ? (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-foreground" : "text-destructive"}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Nuevo método</CardTitle>
          <CardDescription>
            El código se fija al crear y no se puede cambiar: es la clave que usan los reportes
            históricos. Para retirar un método, desactívalo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="new-method-code">Código</Label>
              <Input
                id="new-method-code"
                value={newMethod.code}
                placeholder="NEQUI"
                aria-invalid={fieldErrors.code ? true : undefined}
                onChange={(event) => setNewMethod((current) => ({ ...current, code: event.target.value }))}
              />
              {fieldErrors.code ? <p className="text-xs text-destructive">{fieldErrors.code}</p> : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-method-label">Etiqueta</Label>
              <Input
                id="new-method-label"
                value={newMethod.label}
                placeholder="Nequi"
                aria-invalid={fieldErrors.label ? true : undefined}
                onChange={(event) => setNewMethod((current) => ({ ...current, label: event.target.value }))}
              />
              {fieldErrors.label ? <p className="text-xs text-destructive">{fieldErrors.label}</p> : null}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-method-instructions">Instrucciones (opcional)</Label>
            <textarea
              id="new-method-instructions"
              value={newMethod.instructions}
              rows={3}
              placeholder="Cómo pagar con este método: pasos, datos de la cuenta…"
              onChange={(event) => setNewMethod((current) => ({ ...current, instructions: event.target.value }))}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {fieldErrors.instructions ? (
              <p className="text-xs text-destructive">{fieldErrors.instructions}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={newMethod.requiresReference}
                onChange={(event) =>
                  setNewMethod((current) => ({ ...current, requiresReference: event.target.checked }))
                }
              />
              Exige referencia
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={newMethod.requiresProof}
                onChange={(event) =>
                  setNewMethod((current) => ({ ...current, requiresProof: event.target.checked }))
                }
              />
              Exige comprobante
            </label>
            <Button
              type="button"
              disabled={busy || newMethod.code.trim() === "" || newMethod.label.trim() === ""}
              onClick={onCreate}
            >
              {busy ? "Guardando…" : "Crear método"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Catálogo ({methods.length})</CardTitle>
          <CardDescription>
            El orden define cómo se muestran en el formulario de la semana. Los métodos inactivos
            se conservan porque los reportes antiguos los referencian.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {methods.map((method, index) => {
            const editing = editingId === method.id && draft !== null;
            return (
              <div key={method.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 font-mono text-xs">
                      {method.code}
                    </span>
                    <span className={`text-sm font-medium ${method.isActive ? "" : "text-muted-foreground line-through"}`}>
                      {method.label}
                    </span>
                    {!method.isActive ? (
                      <span className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
                        Inactivo
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      disabled={busy || index === 0}
                      aria-label={`Subir ${method.label}`}
                      onClick={() => onMove(method, "up")}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      disabled={busy || index === methods.length - 1}
                      aria-label={`Bajar ${method.label}`}
                      onClick={() => onMove(method, "down")}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      disabled={busy}
                      onClick={() => {
                        setMessage(null);
                        setFieldErrors({});
                        if (editing) {
                          setEditingId(null);
                          setDraft(null);
                        } else {
                          setEditingId(method.id);
                          setDraft(draftFrom(method));
                        }
                      }}
                    >
                      {editing ? "Cancelar" : "Editar"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      disabled={busy}
                      onClick={() => onToggleActive(method)}
                    >
                      {method.isActive ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                </div>

                {editing ? (
                  <div className="space-y-3 rounded-md border border-dashed p-3">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`label-${method.id}`}>Etiqueta</Label>
                        <Input
                          id={`label-${method.id}`}
                          value={draft.label}
                          aria-invalid={fieldErrors.label ? true : undefined}
                          onChange={(event) => setDraft((current) => (current ? { ...current, label: event.target.value } : current))}
                        />
                        {fieldErrors.label ? <p className="text-xs text-destructive">{fieldErrors.label}</p> : null}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`order-${method.id}`}>Orden</Label>
                        <Input
                          id={`order-${method.id}`}
                          type="number"
                          min={0}
                          max={9999}
                          step={1}
                          inputMode="numeric"
                          value={draft.sortOrder}
                          aria-invalid={fieldErrors.sortOrder ? true : undefined}
                          onChange={(event) =>
                            setDraft((current) => (current ? { ...current, sortOrder: event.target.value } : current))
                          }
                        />
                        {fieldErrors.sortOrder ? <p className="text-xs text-destructive">{fieldErrors.sortOrder}</p> : null}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`instructions-${method.id}`}>Instrucciones (opcional)</Label>
                      <textarea
                        id={`instructions-${method.id}`}
                        value={draft.instructions}
                        rows={3}
                        onChange={(event) =>
                          setDraft((current) => (current ? { ...current, instructions: event.target.value } : current))
                        }
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                      {fieldErrors.instructions ? (
                        <p className="text-xs text-destructive">{fieldErrors.instructions}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-5">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={draft.requiresReference}
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, requiresReference: event.target.checked } : current,
                            )
                          }
                        />
                        Exige referencia
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={draft.requiresProof}
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, requiresProof: event.target.checked } : current,
                            )
                          }
                        />
                        Exige comprobante
                      </label>
                      <Button type="button" disabled={busy} onClick={() => onSaveRow(method)}>
                        {busy ? "Guardando…" : "Guardar"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>
                      Referencia: {method.requiresReference ? "obligatoria" : "no obligatoria"} ·
                      Comprobante: {method.requiresProof ? "obligatorio" : "no obligatorio"} · Orden:{" "}
                      {method.sortOrder}
                    </p>
                    <p className="sm:text-right">
                      {method.instructions ? method.instructions : "Sin instrucciones."}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          {methods.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Todavía no hay métodos configurados.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
