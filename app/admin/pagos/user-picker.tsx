"use client";

// =============================================================================
// app/admin/pagos/user-picker.tsx — autocomplete for filters #4 (persona) and
// #5 (red de): type a name/code/email, submit-to-search, pick a result.
//
// Submit-to-search on purpose (same doctrine as components/network): typing
// does not query, so a 20-keystroke name is one request, not twenty. The pick
// writes a hidden input with the user id, so the surrounding GET form submits
// `userId=<uuid>` like any other filter — in multiple mode it writes ONE hidden
// input PER selected person (repeated params, D79), and the page reads them
// back as a deduped list. In multiple mode the control also follows the D79
// weeks envelope (D82): a summary button, a panel with the search box,
// checkbox results and "Quitar todas"; only the search stays server-side,
// because the directory has thousands of users. The server re-validates every
// uuid anyway.
// =============================================================================

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";

export interface UserPickerOption {
  id: string;
  fullName: string;
  publicCode: string;
}

async function fetchUsers(term: string): Promise<UserPickerOption[]> {
  const response = await fetch(`/api/payments/users?q=${encodeURIComponent(term)}`);
  const envelope = (await response.json()) as
    | { ok: true; data: { results: UserPickerOption[] } }
    | { ok: false; error?: { message?: string } };

  if (!envelope.ok) throw new Error(envelope.error?.message ?? "No se pudo buscar.");
  return envelope.data.results;
}

/**
 * Button copy: the empty label, the single person's name (the applied filter
 * must be readable without opening the panel), or "N personas seleccionadas".
 */
export function userPickerSummary(
  selected: readonly UserPickerOption[],
  emptyLabel: string,
): string {
  if (selected.length === 0) return emptyLabel;
  if (selected.length === 1) return selected[0].fullName;
  return `${selected.length} personas seleccionadas`;
}

/** Checkbox semantics: an already-selected person is removed, a new one appended. */
export function toggleUserSelection(
  selected: readonly UserPickerOption[],
  option: UserPickerOption,
): UserPickerOption[] {
  return selected.some((item) => item.id === option.id)
    ? selected.filter((item) => item.id !== option.id)
    : [...selected, option];
}

interface UserPickerBaseProps {
  name: string;
  label: string;
  placeholder: string;
}

export interface SingleUserPickerProps extends UserPickerBaseProps {
  multiple?: false;
  /** Current selection resolved server-side. */
  initial: UserPickerOption | null;
}

export interface MultipleUserPickerProps extends UserPickerBaseProps {
  multiple: true;
  /** Current selections resolved server-side (one per repeated `name` param). */
  initialSelected: UserPickerOption[];
  /** Summary text when nobody is selected, e.g. "Todas las personas". */
  emptyLabel?: string;
}

export function UserPickerField(props: SingleUserPickerProps | MultipleUserPickerProps) {
  return props.multiple === true ? (
    <MultipleUserPicker {...props} />
  ) : (
    <SingleUserPicker {...props} />
  );
}

function SingleUserPicker({ name, label, placeholder, initial }: SingleUserPickerProps) {
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<UserPickerOption | null>(initial);
  const [results, setResults] = useState<UserPickerOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    setLoading(true);

    try {
      setResults(await fetchUsers(term));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "No se pudo buscar.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const clear = () => {
    setSelected(null);
    setResults(null);
    setError(null);
    setTerm("");
  };

  return (
    <div className="text-sm">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {/* The filter the form actually submits; the widgets around it are UI. */}
      <input type="hidden" name={name} value={selected?.id ?? ""} />

      {selected ? (
        <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3">
          <span className="min-w-0 truncate">
            {selected.fullName}{" "}
            <span className="font-mono text-xs text-muted-foreground">{selected.publicCode}</span>
          </span>
          <button
            type="button"
            onClick={clear}
            className="ml-auto shrink-0 text-xs text-muted-foreground underline"
          >
            Quitar
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              // Enter inside the filter form would submit the whole form; here
              // it means "search", which is why this handler exists.
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
            placeholder={placeholder}
            aria-label={label}
          />
          <Button type="button" variant="outline" onClick={() => void search()} disabled={loading}>
            {loading ? "…" : "Buscar"}
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {!selected && results !== null ? (
        results.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">Sin resultados.</p>
        ) : (
          <ul className="mt-1 divide-y rounded-md border bg-background">
            {results.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => {
                    setSelected(option);
                    setResults(null);
                  }}
                >
                  <span className="min-w-0 truncate">{option.fullName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{option.publicCode}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function MultipleUserPicker({
  name,
  label,
  placeholder,
  initialSelected,
  emptyLabel = "Todas las personas",
}: MultipleUserPickerProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<UserPickerOption[]>(initialSelected);
  const [results, setResults] = useState<UserPickerOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const search = async () => {
    setError(null);
    setLoading(true);

    try {
      setResults(await fetchUsers(term));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "No se pudo buscar.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  // Checkbox semantics: checking adds, unchecking removes. The term and the
  // result list stay put so several people can be toggled per search.
  const toggle = (option: UserPickerOption) => {
    setSelected((previous) => toggleUserSelection(previous, option));
  };

  const summary = userPickerSummary(selected, emptyLabel);
  const chosen = new Set(selected.map((option) => option.id));

  return (
    <div ref={rootRef} className="relative text-sm">
      {/* One repeated param per selected person; nothing is submitted when empty. */}
      {selected.map((option) => (
        <input key={option.id} type="hidden" name={name} value={option.id} />
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

      {selected.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1">
          {selected.map((option) => (
            <li
              key={option.id}
              className="flex min-w-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="min-w-0 max-w-40 truncate">{option.fullName}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {option.publicCode}
              </span>
              <button
                type="button"
                onClick={() => toggle(option)}
                aria-label={`Quitar a ${option.fullName}`}
                className="shrink-0 text-muted-foreground underline"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <div
          id={panelId}
          className="absolute z-20 mt-1 w-full rounded-md border bg-background p-2 shadow-md"
        >
          <div className="mb-2 flex gap-2">
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={(event) => {
                // Enter inside the filter form would submit the whole form; here
                // it means "search", which is why this handler exists.
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search();
                }
              }}
              placeholder={placeholder}
              aria-label={`Buscar en ${label}`}
            />
            <Button type="button" variant="outline" onClick={() => void search()} disabled={loading}>
              {loading ? "…" : "Buscar"}
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {results !== null ? (
            results.length === 0 ? (
              <p className="mt-1 px-1 text-xs text-muted-foreground">Sin resultados.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <ul className="divide-y">
                  {results.map((option) => (
                    <li key={option.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-1 py-2">
                        <input
                          type="checkbox"
                          checked={chosen.has(option.id)}
                          onChange={() => toggle(option)}
                        />
                        <span className="min-w-0 flex-1 truncate">{option.fullName}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {option.publicCode}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelected([])}
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
