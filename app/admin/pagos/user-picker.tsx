"use client";

// =============================================================================
// app/admin/pagos/user-picker.tsx — select2-style pickers for filters #4
// (persona, multiple) and #5 (red de, single).
//
// Both controls list the whole active directory, loaded once with the page
// (D82), and filter it locally as you type: typing narrows the options, never
// the server, so the wire protocol stays the usual GET params. Each pick
// writes a hidden input with the user id — in multiple mode ONE hidden input
// PER selected person (repeated params, D79), and the page reads them back as
// a deduped list. Multiple mode also follows the D79 weeks envelope: a
// summary button, a panel with the search box, checkbox results and "Quitar
// todas". The server re-validates every uuid anyway.
// =============================================================================

import { useEffect, useId, useRef, useState } from "react";

export interface UserPickerOption {
  id: string;
  fullName: string;
  publicCode: string;
  /** Matched by the local filter, never displayed. */
  email?: string | null;
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

/**
 * Case-insensitive match over the name, the public code and the email: the
 * directory list is local (like the weeks control), so filtering never queries.
 */
export function filterUserOptions(
  options: readonly UserPickerOption[],
  term: string,
): UserPickerOption[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter(
    (option) =>
      option.fullName.toLowerCase().includes(needle) ||
      option.publicCode.toLowerCase().includes(needle) ||
      (option.email ?? "").toLowerCase().includes(needle),
  );
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
  /** The whole active directory, loaded with the page (D82). */
  options: readonly UserPickerOption[];
}

export interface MultipleUserPickerProps extends UserPickerBaseProps {
  multiple: true;
  /** Current selections resolved server-side (one per repeated `name` param). */
  initialSelected: UserPickerOption[];
  /** The whole active directory, loaded with the page (D82). */
  options: readonly UserPickerOption[];
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

function SingleUserPicker({
  name,
  label,
  placeholder,
  initial,
  options,
}: SingleUserPickerProps) {
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<UserPickerOption | null>(initial);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

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

  const clear = () => {
    setSelected(null);
    setOpen(false);
    setTerm("");
  };

  const choose = (option: UserPickerOption) => {
    setSelected(option);
    setOpen(false);
    setTerm("");
  };

  const visible = filterUserOptions(options, term);

  return (
    <div ref={rootRef} className="relative text-sm">
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
        <input
          type="text"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            // Enter inside the filter form would submit the whole form; here
            // it only narrows the local list, never the applied filters.
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder={placeholder}
          aria-label={label}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        />
      )}

      {open && !selected ? (
        <div
          id={listId}
          className="absolute z-20 mt-1 w-full rounded-md border bg-background p-1 shadow-md"
        >
          {visible.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Sin resultados.</p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto">
              {visible.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-2 text-left hover:bg-muted/50"
                    onClick={() => choose(option)}
                  >
                    <span className="min-w-0 truncate">{option.fullName}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {option.publicCode}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MultipleUserPicker({
  name,
  label,
  placeholder,
  initialSelected,
  options,
  emptyLabel = "Todas las personas",
}: MultipleUserPickerProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<UserPickerOption[]>(initialSelected);
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

  // Checkbox semantics: checking adds, unchecking removes. The term stays put
  // so several people can be toggled per search; filtering is purely local.
  const toggle = (option: UserPickerOption) => {
    setSelected((previous) => toggleUserSelection(previous, option));
  };

  const summary = userPickerSummary(selected, emptyLabel);
  const chosen = new Set(selected.map((option) => option.id));
  const visible = filterUserOptions(options, term);

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
          <input
            type="text"
            value={term}
            autoFocus
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              // Enter inside the filter form would submit the whole form; here
              // it only narrows the local list, never the applied filters.
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={placeholder}
            aria-label={`Buscar en ${label}`}
            className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />

          {visible.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">Sin resultados.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <ul className="divide-y">
                {visible.map((option) => (
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
          )}

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
