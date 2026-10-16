"use client";

// =============================================================================
// app/admin/configuracion/settings-form.tsx — one form for the whole catalog.
//
// Only DIRTY entries are sent. BOOL travels as boolean; JSON is parsed here so
// a syntax error gets an inline message instead of a server round-trip;
// everything else travels as the typed string, because
// `validateSettingValue` (lib/settings-admin.ts) accepts numeric strings and
// canonicalises DECIMAL itself. Fields above the current role's rank are
// disabled — the service enforces `editable_by` regardless.
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
import { updateSettingsAction } from "@/lib/settings-actions";

export interface SettingsEntryView {
  key: string;
  label: string;
  description: string;
  type: "INT" | "DECIMAL" | "BOOL" | "STRING" | "ENUM" | "JSON";
  editableBy: "ROOT" | "ADMIN" | "MEMBER";
  options: string[] | null;
  minValue: number | null;
  maxValue: number | null;
  /** String for every type except BOOL (boolean) and JSON (JSON text). */
  value: string | boolean;
}

export interface SettingsGroupView {
  name: string;
  entries: SettingsEntryView[];
}

const ROLE_RANK: Record<string, number> = { MEMBER: 0, ADMIN: 1, ROOT: 2 };

export function SettingsForm({
  groups,
  currentRole,
}: {
  groups: SettingsGroupView[];
  currentRole: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const group of groups) {
      for (const entry of group.entries) initial[entry.key] = entry.value;
    }
    return initial;
  });
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const allEntries = groups.flatMap((group) => group.entries);
  const dirtyEntries = allEntries.filter((entry) => values[entry.key] !== entry.value);

  const setValue = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    // A "saved" message must not survive the next edit: once something is
    // dirty again, keeping it would claim the screen has no pending changes.
    setMessage((current) => (current?.kind === "ok" ? null : current));
  };

  const onSave = () => {
    setMessage(null);

    const changes: Array<{ key: string; value: unknown }> = [];
    for (const entry of dirtyEntries) {
      const raw = values[entry.key];

      if (entry.type === "BOOL") {
        changes.push({ key: entry.key, value: raw === true });
        continue;
      }

      const text = typeof raw === "string" ? raw : "";

      if (entry.type === "JSON") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setMessage({
            kind: "error",
            text: `"${entry.label}" no tiene un JSON válido.`,
          });
          return;
        }
        changes.push({ key: entry.key, value: parsed });
        continue;
      }

      changes.push({ key: entry.key, value: text });
    }

    startTransition(async () => {
      const result = await updateSettingsAction(changes);

      if (!result.ok) {
        setMessage({
          kind: "error",
          text: result.message ?? "No se pudieron guardar los ajustes.",
        });
        return;
      }

      setMessage({
        kind: "ok",
        text: `${result.updated?.length ?? 0} ajuste(s) guardado(s).`,
      });
      router.refresh();
    });
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

      {groups.map((group) => (
        <Card key={group.name}>
          <CardHeader>
            <CardTitle className="text-lg">{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {group.entries.map((entry) => {
              const canEdit = (ROLE_RANK[currentRole] ?? 0) >= (ROLE_RANK[entry.editableBy] ?? 0);
              return (
                <div key={entry.key} className="space-y-1">
                  <Label htmlFor={`setting-${entry.key}`}>{entry.label}</Label>
                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                  <SettingField
                    entry={entry}
                    value={values[entry.key] ?? entry.value}
                    disabled={!canEdit}
                    onChange={(value) => setValue(entry.key, value)}
                  />
                  {!canEdit ? (
                    <p className="text-xs text-muted-foreground">
                      Requiere rol {entry.editableBy}.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={busy || dirtyEntries.length === 0}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </Button>
        <span className="text-sm text-muted-foreground">
          {dirtyEntries.length === 0
            ? "Sin cambios pendientes."
            : `${dirtyEntries.length} cambio(s) sin guardar.`}
        </span>
      </div>
    </div>
  );
}

function SettingField({
  entry,
  value,
  disabled,
  onChange,
}: {
  entry: SettingsEntryView;
  value: string | boolean;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `setting-${entry.key}`;

  if (entry.type === "BOOL") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4"
        />
        Activo
      </label>
    );
  }

  if (entry.type === "ENUM") {
    return (
      <select
        id={id}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-10 w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        {(entry.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (entry.type === "JSON") {
    return (
      <textarea
        id={id}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        rows={4}
        onChange={(event) => onChange(event.target.value)}
        className="flex w-full max-w-xl rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
      />
    );
  }

  if (entry.type === "INT") {
    return (
      <Input
        id={id}
        type="number"
        step={1}
        min={entry.minValue ?? undefined}
        max={entry.maxValue ?? undefined}
        inputMode="numeric"
        disabled={disabled}
        value={typeof value === "string" ? value : String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-sm"
      />
    );
  }

  return (
    <Input
      id={id}
      type="text"
      inputMode={entry.type === "DECIMAL" ? "decimal" : undefined}
      disabled={disabled}
      value={typeof value === "string" ? value : String(value)}
      onChange={(event) => onChange(event.target.value)}
      className="max-w-sm"
    />
  );
}
