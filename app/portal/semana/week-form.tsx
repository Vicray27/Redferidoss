"use client";

// =============================================================================
// app/portal/semana/week-form.tsx — the weekly "Visión Celular" report form.
//
// Prefilled from the report the member already saved this week (if any); the
// save is an UPSERT (D44), so submitting again edits the same row until the
// window closes. When the week is not reportable the form degrades to a
// read-only summary — the server would refuse the write anyway, and hiding
// the fields is clearer than a disabled ghost.
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
import { saveWeeklyReportAction } from "@/lib/weekly-actions";

/** Mirrors MAX_WEEKLY_NOTE_LENGTH; literal so the client bundle stays lean. */
const NOTE_MAX_LENGTH = 2000;

export interface WeekDefaults {
  attended: boolean;
  discipleshipAttended: boolean;
  cellsTotal: number;
  cellsHeld: number;
  cellsNotHeld: number;
  cellAttendees: number;
  cellAbsentees: number;
  cellNewVisitors: number;
  cellNewCells: number;
  visitors: string[];
  note: string | null;
}

const COUNTER_FIELDS = [
  { key: "cellsTotal", label: "Células totales" },
  { key: "cellsHeld", label: "Células realizadas" },
  { key: "cellsNotHeld", label: "Células no realizadas" },
  { key: "cellAttendees", label: "Asistentes" },
  { key: "cellAbsentees", label: "Ausentes" },
  { key: "cellNewVisitors", label: "Visitantes nuevos" },
  { key: "cellNewCells", label: "Células nuevas" },
] as const;

type CounterKey = (typeof COUNTER_FIELDS)[number]["key"];

function initialCounters(defaults: WeekDefaults | null): Record<CounterKey, string> {
  const counters = {} as Record<CounterKey, string>;
  for (const field of COUNTER_FIELDS) {
    counters[field.key] = String(defaults?.[field.key] ?? 0);
  }
  return counters;
}

export function WeekForm({
  defaults,
  editable,
}: {
  defaults: WeekDefaults | null;
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const [attended, setAttended] = useState(defaults?.attended ?? false);
  const [discipleshipAttended, setDiscipleshipAttended] = useState(
    defaults?.discipleshipAttended ?? false,
  );
  const [counters, setCounters] = useState<Record<CounterKey, string>>(() =>
    initialCounters(defaults),
  );
  const [visitorsText, setVisitorsText] = useState((defaults?.visitors ?? []).join("\n"));
  const [note, setNote] = useState(defaults?.note ?? "");
  const [detailsOpen, setDetailsOpen] = useState(
    Boolean(
      defaults &&
        (defaults.visitors.length > 0 ||
          (defaults.note !== null && defaults.note.trim() !== "")),
    ),
  );
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const stepCounter = (key: CounterKey, delta: number) => {
    setCounters((current) => {
      const parsed = Number.parseInt(current[key], 10);
      const value = Number.isFinite(parsed) ? parsed : 0;
      return { ...current, [key]: String(Math.max(0, value + delta)) };
    });
  };

  const onSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    const parsed = {} as Record<CounterKey, number>;
    for (const field of COUNTER_FIELDS) {
      const value = Number(counters[field.key]);
      if (!Number.isInteger(value) || value < 0) {
        setMessage({
          kind: "error",
          text: `"${field.label}" debe ser un número entero mayor o igual a 0.`,
        });
        return;
      }
      parsed[field.key] = value;
    }

    const visitors = visitorsText
      .split(/(?:\r?\n|,)+/)
      .map((name) => name.trim())
      .filter((name) => name !== "");

    startTransition(async () => {
      const result = await saveWeeklyReportAction({
        attended,
        discipleshipAttended,
        counters: parsed,
        visitors,
        note: note.trim() === "" ? null : note,
      });

      if (!result.ok) {
        setMessage({ kind: "error", text: result.message ?? "No se pudo guardar el reporte." });
        return;
      }

      setMessage({
        kind: "ok",
        text: "Reporte guardado. Puedes actualizarlo hasta que cierre la semana.",
      });
      router.refresh();
    });
  };

  if (!editable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reporte de la semana</CardTitle>
          <CardDescription>
            {defaults
              ? "La semana cerró. Este es el reporte que quedó registrado."
              : "La semana cerró y no registraste reporte."}
          </CardDescription>
        </CardHeader>
        {defaults ? (
          <CardContent className="space-y-2 text-sm">
            <p>
              Asistencia: <span className="font-medium">{defaults.attended ? "Sí" : "No"}</span> ·
              Discipulado:{" "}
              <span className="font-medium">{defaults.discipleshipAttended ? "Sí" : "No"}</span>
            </p>
            <p>
              Células: {defaults.cellsHeld} de {defaults.cellsTotal} · Asistentes:{" "}
              {defaults.cellAttendees} · Visitantes nuevos: {defaults.cellNewVisitors}
            </p>
            {defaults.note ? <p className="text-muted-foreground">Nota: {defaults.note}</p> : null}
          </CardContent>
        ) : null}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Reporte de la semana</CardTitle>
        <CardDescription>
          Marca tu propia asistencia y los números de tu célula. Cada persona se
          reporta a sí misma.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSave} className="space-y-4">
          <div className="space-y-3">
            <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                checked={attended}
                onChange={(event) => setAttended(event.target.checked)}
                className="h-5 w-5"
              />
              Asistí a la reunión general
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                checked={discipleshipAttended}
                onChange={(event) => setDiscipleshipAttended(event.target.checked)}
                className="h-5 w-5"
              />
              Asistí al discipulado
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
            {COUNTER_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`week-${field.key}`}>{field.label}</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Restar ${field.label}`}
                    onClick={() => stepCounter(field.key, -1)}
                    className="h-9 w-9 shrink-0 p-0 text-base leading-none"
                  >
                    −
                  </Button>
                  <Input
                    id={`week-${field.key}`}
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={counters[field.key]}
                    onChange={(event) =>
                      setCounters((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    className="text-center"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Sumar ${field.label}`}
                    onClick={() => stepCounter(field.key, 1)}
                    className="h-9 w-9 shrink-0 p-0 text-base leading-none"
                  >
                    +
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <details
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
            className="space-y-3 rounded-md border p-3"
          >
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
              Más detalles (visitantes y nota)
            </summary>

            <div className="space-y-1">
              <Label htmlFor="week-visitors">Visitantes (un nombre por línea)</Label>
              <textarea
                id="week-visitors"
                value={visitorsText}
                onChange={(event) => setVisitorsText(event.target.value)}
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground sm:text-sm"
                placeholder="María Pérez&#10;Juan Gómez"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="week-note">Nota (opcional)</Label>
              <textarea
                id="week-note"
                value={note}
                maxLength={NOTE_MAX_LENGTH}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground sm:text-sm"
              />
            </div>
          </details>

          {message ? (
            <p
              className={`text-sm ${message.kind === "ok" ? "text-foreground" : "text-destructive"}`}
              role={message.kind === "error" ? "alert" : "status"}
            >
              {message.text}
            </p>
          ) : null}

          <Button type="submit" disabled={busy} className="min-h-11 w-full sm:w-auto">
            {busy ? "Guardando…" : "Guardar reporte"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
