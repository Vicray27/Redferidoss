"use client";

// =============================================================================
// components/ui/multi-select.tsx — a dependency-free, searchable MULTI-select
// for GET filter forms (no Radix, same doctrine as components/ui/form.tsx).
//
// The form protocol is REPEATED PARAMS: one hidden input per selected value,
// exactly what the native `<select multiple>` produced, so the server keeps
// reading the filter with `getAll(name)` and the wire format does not change.
// The summary button always states the current selection ("2 semanas
// seleccionadas"): the control it replaces (a ctrl-click list) hid the
// selection behind a scroll, which is the confusion it fixes.
// =============================================================================

import { useEffect, useId, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Raw key shown next to the label and matched by the search (e.g. a period key). */
  secondary?: string;
}

/** Case-insensitive match over the human label and the secondary key. */
export function filterMultiSelectOptions(
  options: readonly MultiSelectOption[],
  term: string,
): MultiSelectOption[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.secondary ?? "").toLowerCase().includes(needle),
  );
}

/**
 * Button copy: the empty label, the single option's label (the applied filter
 * must be readable without opening the panel), or "N <noun>s seleccionadas".
 * Unknown values (a stale URL) fall back to the raw value instead of lying.
 */
export function multiSelectSummary(
  options: readonly MultiSelectOption[],
  values: readonly string[],
  emptyLabel: string,
  summaryNoun: string,
): string {
  if (values.length === 0) return emptyLabel;
  if (values.length === 1) {
    const value = values[0];
    return options.find((option) => option.value === value)?.label ?? value;
  }
  return `${values.length} ${summaryNoun}s seleccionadas`;
}

export function MultiSelect({
  name,
  label,
  options,
  selected,
  emptyLabel,
  searchPlaceholder,
  summaryNoun,
}: {
  /** Form field name; one hidden input is rendered per selected value. */
  name: string;
  /** Accessible name of the control (also used in the search input label). */
  label: string;
  options: readonly MultiSelectOption[];
  selected: readonly string[];
  /** Summary text when nothing is selected, e.g. "Todas las semanas". */
  emptyLabel: string;
  searchPlaceholder: string;
  /** Singular noun for the count summary, e.g. "semana" -> "3 semanas seleccionadas". */
  summaryNoun: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  // The URL is the source of truth on load; from there this is uncontrolled
  // until the form is submitted.
  const [values, setValues] = useState<string[]>(() => [...new Set(selected)]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const summary = multiSelectSummary(options, values, emptyLabel, summaryNoun);
  const chosen = new Set(values);
  const visible = filterMultiSelectOptions(options, term);

  const toggle = (value: string) => {
    setValues((previous) =>
      previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value],
    );
  };

  return (
    <div ref={rootRef} className="relative text-sm">
      {/* The filters the form actually submits; everything else is UI. */}
      {values.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}

      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((previous) => !previous)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ▾
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          className="absolute z-20 mt-1 w-full rounded-md border bg-background p-2 shadow-md"
        >
          <input
            type="text"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              // Enter inside the filter form would submit the whole form; here
              // it only edits the local search, never the applied filters.
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={searchPlaceholder}
            aria-label={`Buscar en ${label}`}
            className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />

          <div className="max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">Sin resultados.</p>
            ) : (
              <ul className="divide-y">
                {visible.map((option) => (
                  <li key={option.value}>
                    <label className="flex cursor-pointer items-center gap-2 px-1 py-2">
                      <input
                        type="checkbox"
                        checked={chosen.has(option.value)}
                        onChange={() => toggle(option.value)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={option.secondary}>
                        {option.label}
                      </span>
                      {option.secondary === undefined ? null : (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {option.secondary}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {values.length > 0 ? (
            <button
              type="button"
              onClick={() => setValues([])}
              className="mt-2 text-xs text-muted-foreground underline"
            >
              Quitar todas
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
