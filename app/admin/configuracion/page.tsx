import { SessionShell } from "@/components/session-shell";
import { requireStaffSession } from "@/lib/auth/require";
import { prisma } from "@/lib/db";
import { SETTINGS_CATALOG, type CatalogEntry } from "@/lib/settings-catalog";

import { SettingsForm, type SettingsEntryView } from "./settings-form";

// =============================================================================
// app/admin/configuracion/page.tsx — the §8.5 system settings screen.
//
// The CATALOG is the source of truth for what exists (label, type, range,
// options, minimum role); the database only supplies current values, and a
// missing row falls back to the catalog default — the seed writes every row,
// so the fallback is a safety net, not a code path. The form posts raw values
// and lib/settings-admin.ts validates everything server-side.
// =============================================================================

export const dynamic = "force-dynamic";

interface SettingRow {
  key: string;
  value: unknown;
}

export default async function SettingsPage() {
  const session = await requireStaffSession("/admin/configuracion");

  const rows = await prisma.$queryRaw<SettingRow[]>`
    SELECT key, value FROM settings ORDER BY key
  `;
  const valueByKey = new Map(rows.map((row) => [row.key, row.value]));

  const groups = new Map<string, SettingsEntryView[]>();
  for (const entry of SETTINGS_CATALOG) {
    const rawValue = valueByKey.has(entry.key) ? valueByKey.get(entry.key) : entry.value;
    const view: SettingsEntryView = {
      key: entry.key,
      label: entry.label,
      description: entry.description,
      type: entry.type,
      editableBy: entry.editableBy,
      options: entry.options ? [...entry.options] : null,
      minValue: entry.minValue ?? null,
      maxValue: entry.maxValue ?? null,
      value: toFormValue(entry.type, rawValue),
    };

    const list = groups.get(entry.groupName) ?? [];
    list.push(view);
    groups.set(entry.groupName, list);
  }

  return (
    <SessionShell
      session={session}
      title="Configuración"
      description="Ajustes del sistema. Cada cambio queda auditado con quién lo hizo y qué cambió."
    >
      <SettingsForm
        groups={[...groups.entries()].map(([name, entries]) => ({ name, entries }))}
        currentRole={session.role}
      />
    </SessionShell>
  );
}

/** BOOL stays boolean; JSON becomes pretty text; everything else a string. */
function toFormValue(type: CatalogEntry["type"], value: unknown): string | boolean {
  if (type === "BOOL") return value === true;
  if (type === "JSON") return JSON.stringify(value ?? null, null, 2);
  return value === null || value === undefined ? "" : String(value);
}
