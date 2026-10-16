"use client";

// =============================================================================
// app/admin/campos-personalizados/custom-fields-manager.tsx — the CRUD screen.
//
// One card creates a field; one row per existing field edits it in place, with
// a LIVE preview built from the SAME renderer the member forms use
// (components/dynamic-form/field-renderer.tsx, §8.5 "CRUD con previsualización
// del formulario"). The preview is a mirror, not the judge: the server
// re-validates every definition (lib/custom-fields-admin.ts) and every
// submitted value (lib/custom-fields.ts).
//
// entity/code/type NEVER render as inputs on an existing field: they are
// frozen after create (D56), so the screen cannot even suggest otherwise.
// "Desactivar" is the retirement path — there is no delete.
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
import {
  createCustomFieldAction,
  moveCustomFieldAction,
  updateCustomFieldAction,
  type CustomFieldActionResult,
} from "@/lib/custom-fields-actions";

export type FieldEntity = "USER" | "PAYMENT_REPORT";
export type FieldVisibility = "MEMBER" | "ADMIN" | "ROOT";

export interface CustomFieldItem {
  id: string;
  entity: FieldEntity;
  code: string;
  label: string;
  type: string;
  options: string[] | null;
  isRequired: boolean;
  isUnique: boolean;
  showInRegistration: boolean;
  showInProfile: boolean;
  showInDashboard: boolean;
  visibleTo: FieldVisibility | null;
  regex: string | null;
  minNumeric: string | null;
  maxNumeric: string | null;
  defaultValue: unknown;
  sortOrder: number;
  isActive: boolean;
}

// Local mirror of the server catalog (lib/custom-fields-admin.ts) so the
// client bundle never pulls the service (and its Prisma import) in.
const FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DECIMAL",
  "DATE",
  "DATETIME",
  "BOOL",
  "SELECT",
  "MULTISELECT",
  "FILE",
  "EMAIL",
  "PHONE",
  "URL",
] as const;

const CHOICE_TYPES = new Set(["SELECT", "MULTISELECT"]);
const PATTERN_TYPES = new Set(["TEXT", "TEXTAREA"]);
const RANGE_TYPES = new Set(["NUMBER", "DECIMAL"]);

const TYPE_LABELS: Record<string, string> = {
  TEXT: "Texto",
  TEXTAREA: "Texto largo",
  NUMBER: "Número entero",
  DECIMAL: "Número decimal",
  DATE: "Fecha",
  DATETIME: "Fecha y hora",
  BOOL: "Sí/No",
  SELECT: "Selección única",
  MULTISELECT: "Selección múltiple",
  FILE: "Archivo",
  EMAIL: "Correo",
  PHONE: "Teléfono",
  URL: "Enlace",
};

const DEFAULT_HINTS: Record<string, string> = {
  BOOL: "sí o no",
  NUMBER: "un número entero",
  DECIMAL: "un número (se conserva el texto exacto)",
  DATE: "AAAA-MM-DD",
  DATETIME: "fecha y hora",
  SELECT: "una de las opciones",
  MULTISELECT: "opciones separadas por coma",
};

interface DraftValues {
  entity: FieldEntity;
  code: string;
  label: string;
  type: string;
  optionsText: string;
  isRequired: boolean;
  isUnique: boolean;
  showInRegistration: boolean;
  showInProfile: boolean;
  showInDashboard: boolean;
  visibleTo: "" | FieldVisibility;
  regex: string;
  minNumeric: string;
  maxNumeric: string;
  defaultValueText: string;
  sortOrder: string;
  isActive: boolean;
}

const EMPTY_DRAFT: DraftValues = {
  entity: "USER",
  code: "",
  label: "",
  type: "TEXT",
  optionsText: "",
  isRequired: false,
  isUnique: false,
  showInRegistration: true,
  showInProfile: false,
  showInDashboard: false,
  visibleTo: "",
  regex: "",
  minNumeric: "",
  maxNumeric: "",
  defaultValueText: "",
  sortOrder: "",
  isActive: true,
};

function formatDefaultText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "sí" : "no";
  return String(value);
}

function draftFrom(field: CustomFieldItem): DraftValues {
  return {
    entity: field.entity,
    code: field.code,
    label: field.label,
    type: field.type,
    optionsText: (field.options ?? []).join("\n"),
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    showInRegistration: field.showInRegistration,
    showInProfile: field.showInProfile,
    showInDashboard: field.showInDashboard,
    visibleTo: field.visibleTo ?? "",
    regex: field.regex ?? "",
    minNumeric: field.minNumeric ?? "",
    maxNumeric: field.maxNumeric ?? "",
    defaultValueText: formatDefaultText(field.defaultValue),
    sortOrder: String(field.sortOrder),
    isActive: field.isActive,
  };
}

function parseOptions(optionsText: string): string[] {
  return optionsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * BOOL is the one type parsed client-side (a checkbox-like "sí" has no other
 * spelling); everything else travels as the raw text and the server decides —
 * DECIMAL in particular must keep its exact form.
 */
function parseDefaultValue(values: DraftValues): unknown {
  const raw = values.defaultValueText.trim();
  if (raw === "") return null;
  if (values.type === "BOOL") {
    const text = raw.toLowerCase();
    if (text === "sí" || text === "si" || text === "true" || text === "1") return true;
    if (text === "no" || text === "false" || text === "0") return false;
    return raw; // the server rejects it with its own message
  }
  if (values.type === "MULTISELECT") {
    return raw
      .split(",")
      .map((choice) => choice.trim())
      .filter((choice) => choice !== "");
  }
  return raw;
}

export function CustomFieldsManager({ fields }: { fields: CustomFieldItem[] }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftValues | null>(null);
  const [newField, setNewField] = useState<DraftValues>(EMPTY_DRAFT);

  const run = (
    action: () => Promise<CustomFieldActionResult>,
    okText: string,
    onSuccess?: () => void,
  ) => {
    setMessage(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo guardar el campo." });
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
        createCustomFieldAction({
          entity: newField.entity,
          code: newField.code,
          label: newField.label,
          type: newField.type as (typeof FIELD_TYPES)[number],
          options: parseOptions(newField.optionsText),
          isRequired: newField.isRequired,
          isUnique: newField.isUnique,
          showInRegistration: newField.showInRegistration,
          showInProfile: newField.showInProfile,
          showInDashboard: newField.showInDashboard,
          visibleTo: newField.visibleTo === "" ? null : newField.visibleTo,
          regex: newField.regex,
          minNumeric: newField.minNumeric,
          maxNumeric: newField.maxNumeric,
          defaultValue: parseDefaultValue(newField),
          sortOrder: newField.sortOrder === "" ? undefined : Number(newField.sortOrder),
        }),
      "Campo creado.",
      // Only clear the form once the server accepted it — an error must not
      // eat what the admin typed.
      () => setNewField(EMPTY_DRAFT),
    );
  };

  const onSaveRow = (field: CustomFieldItem) => {
    if (draft === null) return;
    run(
      () =>
        updateCustomFieldAction(field.id, {
          label: draft.label,
          options: parseOptions(draft.optionsText),
          isRequired: draft.isRequired,
          isUnique: draft.isUnique,
          showInRegistration: draft.showInRegistration,
          showInProfile: draft.showInProfile,
          showInDashboard: draft.showInDashboard,
          visibleTo: draft.visibleTo === "" ? null : draft.visibleTo,
          regex: draft.regex,
          minNumeric: draft.minNumeric,
          maxNumeric: draft.maxNumeric,
          defaultValue: parseDefaultValue(draft),
          sortOrder: draft.sortOrder === "" ? undefined : Number(draft.sortOrder),
          isActive: draft.isActive,
        }),
      `«${draft.label}» guardado.`,
    );
  };

  const onToggleActive = (field: CustomFieldItem) => {
    run(
      () => updateCustomFieldAction(field.id, { isActive: !field.isActive }),
      field.isActive ? `«${field.label}» desactivado.` : `«${field.label}» activado.`,
    );
  };

  const onMove = (field: CustomFieldItem, direction: "up" | "down") => {
    run(() => moveCustomFieldAction(field.id, direction), "Orden actualizado.");
  };

  const groups: Array<{ entity: FieldEntity; title: string; description: string }> = [
    {
      entity: "USER",
      title: "Miembros",
      description: "Campos de la ficha del miembro. Los que marques «En el registro» aparecen en el formulario de invitación.",
    },
    {
      entity: "PAYMENT_REPORT",
      title: "Reportes de pago",
      description: "Campos del aporte semanal. Los que marques «En el panel/exportaciones» aparecen como columnas en la tabla maestra de pagos y en sus exportaciones.",
    },
  ];

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
          <CardTitle className="text-lg">Nuevo campo</CardTitle>
          <CardDescription>
            El código y el tipo se fijan al crear: identifican al campo en los formularios y en las
            exportaciones. Para retirar un campo, desactívalo — sus valores históricos se conservan.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-4">
            <FieldDraftForm
              values={newField}
              onChange={setNewField}
              fieldErrors={fieldErrors}
              idPrefix="new-field"
              lockIdentity={false}
              showActive={false}
            />
            <Button
              type="button"
              disabled={busy || newField.code.trim() === "" || newField.label.trim() === ""}
              onClick={onCreate}
            >
              {busy ? "Guardando…" : "Crear campo"}
            </Button>
          </div>
          <FieldPreview values={newField} />
        </CardContent>
      </Card>

      {groups.map((group) => {
        const items = fields.filter((field) => field.entity === group.entity);
        return (
          <Card key={group.entity}>
            <CardHeader>
              <CardTitle className="text-lg">
                {group.title} ({items.length})
              </CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="divide-y">
              {items.map((field, index) => {
                const editing = editingId === field.id && draft !== null;
                return (
                  <div key={field.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 font-mono text-xs">
                          {field.code}
                        </span>
                        <span
                          className={`text-sm font-medium ${field.isActive ? "" : "text-muted-foreground line-through"}`}
                        >
                          {field.label}
                        </span>
                        <span className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
                          {TYPE_LABELS[field.type] ?? field.type}
                        </span>
                        {field.isRequired ? (
                          <span className="rounded-full border border-dashed px-2 py-0.5 text-xs">
                            Obligatorio
                          </span>
                        ) : null}
                        {field.isUnique ? (
                          <span className="rounded-full border border-dashed px-2 py-0.5 text-xs">
                            Único
                          </span>
                        ) : null}
                        {!field.isActive ? (
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
                          aria-label={`Subir ${field.label}`}
                          onClick={() => onMove(field, "up")}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 px-3 text-xs"
                          disabled={busy || index === items.length - 1}
                          aria-label={`Bajar ${field.label}`}
                          onClick={() => onMove(field, "down")}
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
                              setEditingId(field.id);
                              setDraft(draftFrom(field));
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
                          onClick={() => onToggleActive(field)}
                        >
                          {field.isActive ? "Desactivar" : "Activar"}
                        </Button>
                      </div>
                    </div>

                    {editing ? (
                      <div className="grid gap-6 rounded-md border border-dashed p-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <div className="space-y-4">
                          <FieldDraftForm
                            values={draft}
                            onChange={setDraft}
                            fieldErrors={fieldErrors}
                            idPrefix={field.id}
                            lockIdentity
                            showActive
                          />
                          <Button type="button" disabled={busy} onClick={() => onSaveRow(field)}>
                            {busy ? "Guardando…" : "Guardar"}
                          </Button>
                        </div>
                        <FieldPreview values={draft} />
                      </div>
                    ) : (
                      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                        <p>{describePlacement(field)}</p>
                        <p className="sm:text-right">
                          Orden: {field.sortOrder}
                          {field.options && field.options.length > 0
                            ? ` · Opciones: ${field.options.join(", ")}`
                            : ""}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
              {items.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Todavía no hay campos configurados.</p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function describePlacement(field: CustomFieldItem): string {
  const where: string[] = [];
  if (field.showInRegistration) where.push("En el registro");
  if (field.showInProfile) where.push("En el perfil");
  if (field.showInDashboard) where.push("En el panel/exportaciones");
  const visibility =
    field.visibleTo === null
      ? "Sin restricción de visibilidad"
      : `Visible para ${visibilityLabel(field.visibleTo)}`;
  return `${where.length > 0 ? where.join(" · ") : "No se muestra en ningún formulario"} · ${visibility}`;
}

function visibilityLabel(visibility: FieldVisibility): string {
  if (visibility === "MEMBER") return "miembros y superior";
  if (visibility === "ADMIN") return "administración y root";
  return "solo root";
}

function FieldDraftForm({
  values,
  onChange,
  fieldErrors,
  idPrefix,
  lockIdentity,
  showActive,
}: {
  values: DraftValues;
  onChange: (next: DraftValues) => void;
  fieldErrors: Record<string, string>;
  idPrefix: string;
  lockIdentity: boolean;
  showActive: boolean;
}) {
  const set = <K extends keyof DraftValues>(key: K, value: DraftValues[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <div className="space-y-4">
      {lockIdentity ? (
        <p className="text-xs text-muted-foreground">
          Código, entidad y tipo quedaron fijos al crear el campo (D56). Para cambiar el tipo,
          desactiva este campo y crea uno nuevo.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-entity`}>Entidad</Label>
            <select
              id={`${idPrefix}-entity`}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={values.entity}
              onChange={(event) => set("entity", event.target.value as FieldEntity)}
            >
              <option value="USER">Miembro</option>
              <option value="PAYMENT_REPORT">Reporte de pago</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-code`}>Código</Label>
            <Input
              id={`${idPrefix}-code`}
              value={values.code}
              placeholder="BARRIO"
              aria-invalid={fieldErrors.code ? true : undefined}
              onChange={(event) => set("code", event.target.value)}
            />
            <ErrorText message={fieldErrors.code} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-type`}>Tipo</Label>
            <select
              id={`${idPrefix}-type`}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={values.type}
              onChange={(event) => set("type", event.target.value)}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type] ?? type}
                </option>
              ))}
            </select>
            <ErrorText message={fieldErrors.type} />
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-label`}>Etiqueta</Label>
        <Input
          id={`${idPrefix}-label`}
          value={values.label}
          placeholder="Barrio"
          aria-invalid={fieldErrors.label ? true : undefined}
          onChange={(event) => set("label", event.target.value)}
        />
        <ErrorText message={fieldErrors.label} />
      </div>

      {CHOICE_TYPES.has(values.type) ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-options`}>Opciones (una por línea)</Label>
          <textarea
            id={`${idPrefix}-options`}
            rows={4}
            value={values.optionsText}
            placeholder={"Norte\nSur\nCentro"}
            aria-invalid={fieldErrors.options ? true : undefined}
            onChange={(event) => set("optionsText", event.target.value)}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <ErrorText message={fieldErrors.options} />
        </div>
      ) : null}

      {PATTERN_TYPES.has(values.type) ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-regex`}>Patrón (opcional)</Label>
          <Input
            id={`${idPrefix}-regex`}
            value={values.regex}
            placeholder="^[0-9]{6}$"
            aria-invalid={fieldErrors.regex ? true : undefined}
            onChange={(event) => set("regex", event.target.value)}
          />
          <ErrorText message={fieldErrors.regex} />
        </div>
      ) : null}

      {RANGE_TYPES.has(values.type) ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-min`}>Mínimo (opcional)</Label>
            <Input
              id={`${idPrefix}-min`}
              value={values.minNumeric}
              inputMode="decimal"
              aria-invalid={fieldErrors.minNumeric ? true : undefined}
              onChange={(event) => set("minNumeric", event.target.value)}
            />
            <ErrorText message={fieldErrors.minNumeric} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-max`}>Máximo (opcional)</Label>
            <Input
              id={`${idPrefix}-max`}
              value={values.maxNumeric}
              inputMode="decimal"
              aria-invalid={fieldErrors.maxNumeric ? true : undefined}
              onChange={(event) => set("maxNumeric", event.target.value)}
            />
            <ErrorText message={fieldErrors.maxNumeric} />
          </div>
        </div>
      ) : null}

      {values.type !== "FILE" ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-default`}>Valor sugerido (opcional)</Label>
          <Input
            id={`${idPrefix}-default`}
            value={values.defaultValueText}
            placeholder={DEFAULT_HINTS[values.type] ?? "un valor"}
            aria-invalid={fieldErrors.defaultValue ? true : undefined}
            onChange={(event) => set("defaultValueText", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Solo precede el formulario: la persona puede cambiarlo antes de enviar.
          </p>
          <ErrorText message={fieldErrors.defaultValue} />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-visible`}>Visibilidad</Label>
          <select
            id={`${idPrefix}-visible`}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={values.visibleTo}
            onChange={(event) => set("visibleTo", event.target.value as DraftValues["visibleTo"])}
          >
            <option value="">Sin restricción</option>
            <option value="MEMBER">Miembros y superior</option>
            <option value="ADMIN">Administración y root</option>
            <option value="ROOT">Solo root</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Rol mínimo que puede ver el campo en las vistas de lectura (D56).
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-order`}>Orden</Label>
          <Input
            id={`${idPrefix}-order`}
            type="number"
            min={0}
            max={9999}
            step={1}
            inputMode="numeric"
            value={values.sortOrder}
            aria-invalid={fieldErrors.sortOrder ? true : undefined}
            onChange={(event) => set("sortOrder", event.target.value)}
          />
          <ErrorText message={fieldErrors.sortOrder} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.isRequired}
            onChange={(event) => set("isRequired", event.target.checked)}
          />
          Obligatorio
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.isUnique}
            disabled={values.type === "FILE"}
            onChange={(event) => set("isUnique", event.target.checked)}
          />
          Único
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.showInRegistration}
            onChange={(event) => set("showInRegistration", event.target.checked)}
          />
          En el registro
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.showInProfile}
            onChange={(event) => set("showInProfile", event.target.checked)}
          />
          En el perfil
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.showInDashboard}
            onChange={(event) => set("showInDashboard", event.target.checked)}
          />
          En el panel/exportaciones
        </label>
        {showActive ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={values.isActive}
              onChange={(event) => set("isActive", event.target.checked)}
            />
            Activo
          </label>
        ) : null}
      </div>
    </div>
  );
}

function FieldPreview({ values }: { values: DraftValues }) {
  const [value, setValue] = useState<unknown>(null);

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div>
        <p className="text-sm font-medium">Previsualización</p>
        <p className="text-xs text-muted-foreground">Así lo verá quien complete el formulario.</p>
      </div>
      {values.type === "FILE" ? (
        <p className="text-sm text-muted-foreground">
          Los archivos no se adjuntan en este formulario: los comprobantes llegan con la carga de
          cada reporte (D25).
        </p>
      ) : (
        <FieldRenderer
          field={{
            code: values.code || "campo",
            label: values.label.trim() === "" ? "Campo sin título" : values.label,
            type: values.type,
            options: parseOptions(values.optionsText),
            isRequired: values.isRequired,
            regex: values.regex.trim() === "" ? null : values.regex,
            minNumeric: values.minNumeric.trim() === "" ? null : values.minNumeric,
            maxNumeric: values.maxNumeric.trim() === "" ? null : values.maxNumeric,
            sortOrder: 0,
            defaultValue: null,
          }}
          value={value}
          onChange={setValue}
        />
      )}
      <p className="text-xs text-muted-foreground">
        La validación final siempre ocurre en el servidor, con estos mismos criterios.
      </p>
    </div>
  );
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
