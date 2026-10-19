"use client";

// =============================================================================
// app/admin/configuracion/settings-form.tsx — one form for the whole catalog.
//
// Tabs group the catalog but do not split the form state: every value lives in
// the same `values` map, so switching tabs never discards an edit. Only DIRTY
// entries are sent. BOOL travels as boolean; JSON is parsed here so a syntax
// error gets an inline message instead of a server round-trip; everything else
// travels as the typed string, because `validateSettingValue`
// (lib/settings-admin.ts) accepts numeric strings and canonicalises DECIMAL
// itself. Fields above the current role's rank are disabled — the service
// enforces `editable_by` regardless.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui/form";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { updateSettingsAction } from "@/lib/settings-actions";
import {
  ROLE_LABELS,
  SETTINGS_GROUP_LABELS,
  settingOptionLabel,
} from "@/lib/ui-labels";

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

/** Tab order for the settings screen. Keys/group names stay untouched. */
const GROUP_ORDER = ["general", "referral", "payments", "visibility", "security"];

const REMINDER_DAYS_KEY = "payments.reminder_days_before_due";

const DAYS_ERROR =
  "Revisa los días de aviso: usa números enteros entre 0 y 30, separados por comas.";

function daysTextToArray(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const days: number[] = [];
  for (const part of trimmed.split(",")) {
    const chunk = part.trim();
    if (!/^\d+$/.test(chunk)) return null;
    const day = Number(chunk);
    if (!Number.isInteger(day) || day < 0 || day > 30) return null;
    days.push(day);
  }
  return days;
}

/** Stored JSON text (`[1,3]`) -> friendly input text (`1, 3`). */
function storedDaysText(value: string | boolean): string {
  if (typeof value !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is number => typeof item === "number").join(", ");
    }
  } catch {
    // Not valid JSON: keep the raw text so the user can see and fix it.
  }
  return value;
}

function initialFieldValue(entry: SettingsEntryView): string | boolean {
  if (entry.key === REMINDER_DAYS_KEY) return storedDaysText(entry.value);
  return entry.value;
}

function isDirty(entry: SettingsEntryView, value: string | boolean): boolean {
  if (entry.key === REMINDER_DAYS_KEY) {
    const current = daysTextToArray(typeof value === "string" ? value : "");
    const stored = daysTextToArray(storedDaysText(entry.value));
    if (current === null || stored === null) return true;
    return current.join(",") !== stored.join(",");
  }
  return value !== entry.value;
}

function groupRank(name: string): number {
  const index = GROUP_ORDER.indexOf(name);
  return index === -1 ? GROUP_ORDER.length : index;
}

export function SettingsForm({
  groups,
  currentRole,
}: {
  groups: SettingsGroupView[];
  currentRole: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const orderedGroups = [...groups].sort(
    (left, right) => groupRank(left.name) - groupRank(right.name),
  );

  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const group of groups) {
      for (const entry of group.entries) initial[entry.key] = initialFieldValue(entry);
    }
    return initial;
  });
  const [activeTab, setActiveTab] = useState(() => orderedGroups[0]?.name ?? "general");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const allEntries = groups.flatMap((group) => group.entries);
  const dirtyEntries = allEntries.filter((entry) =>
    isDirty(entry, values[entry.key] ?? entry.value),
  );

  const groupForEntry = (key: string) =>
    groups.find((group) => group.entries.some((entry) => entry.key === key));

  const focusGroupForEntry = (key: string) => {
    const group = groupForEntry(key);
    if (group) setActiveTab(group.name);
  };

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

      if (entry.key === REMINDER_DAYS_KEY) {
        const days = daysTextToArray(text);
        if (days === null) {
          setMessage({ kind: "error", text: DAYS_ERROR });
          focusGroupForEntry(entry.key);
          return;
        }
        changes.push({ key: entry.key, value: days });
        continue;
      }

      if (entry.type === "JSON") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setMessage({ kind: "error", text: "Revisa el formato de la lista." });
          focusGroupForEntry(entry.key);
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
        const text = result.message ?? "No se pudieron guardar los ajustes.";
        setMessage({ kind: "error", text });
        // The action returns a message, not structured field errors. If the
        // message names one of the dirty fields, open the tab that owns it so
        // the user does not have to hunt across five tabs.
        const failed = dirtyEntries.find((entry) => text.includes(entry.label));
        if (failed) focusGroupForEntry(failed.key);
        return;
      }

      setMessage({
        kind: "ok",
        text: `${result.updated?.length ?? 0} ajuste(s) guardado(s).`,
      });
      router.refresh();
    });
  };

  const tabItems = orderedGroups.map((group) => ({
    id: group.name,
    label: SETTINGS_GROUP_LABELS[group.name] ?? group.name,
    badge: group.entries.filter((entry) =>
      isDirty(entry, values[entry.key] ?? entry.value),
    ).length,
  }));

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

      <Tabs
        items={tabItems}
        value={activeTab}
        onValueChange={setActiveTab}
        label="Grupos de configuración"
      >
        {orderedGroups.map((group) => (
          <TabsPanel key={group.name} id={group.name}>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {SETTINGS_GROUP_LABELS[group.name] ?? group.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {group.entries.map((entry) => {
                  const canEdit =
                    (ROLE_RANK[currentRole] ?? 0) >= (ROLE_RANK[entry.editableBy] ?? 0);
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
                          Requiere rol {ROLE_LABELS[entry.editableBy] ?? entry.editableBy}.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </TabsPanel>
        ))}
      </Tabs>

      <div className="flex flex-wrap items-center gap-3">
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
        {(entry.options ?? []).map((option) => {
          const unavailable = entry.key === "general.locale" && option === "en";
          return (
            <option key={option} value={option} disabled={unavailable}>
              {unavailable ? "Inglés (no disponible todavía)" : settingOptionLabel(option)}
            </option>
          );
        })}
      </select>
    );
  }

  if (entry.key === REMINDER_DAYS_KEY) {
    return (
      <div className="space-y-1">
        <Input
          id={id}
          type="text"
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          placeholder="1, 3"
          onChange={(event) => onChange(event.target.value)}
          className="max-w-sm"
        />
        <p className="text-xs text-muted-foreground">
          Separa los días con comas. Déjalo vacío para no enviar avisos.
        </p>
      </div>
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
