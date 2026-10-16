"use client";

// =============================================================================
// app/admin/pagos/user-picker.tsx — autocomplete for filters #4 (persona) and
// #5 (red de): type a name/code/email, submit-to-search, pick a result.
//
// Submit-to-search on purpose (same doctrine as components/network): typing
// does not query, so a 20-keystroke name is one request, not twenty. The pick
// writes a hidden input with the user id, so the surrounding GET form submits
// `userId=<uuid>` like any other filter. Picking the wrong person is one click
// to undo ("Quitar"), and the server re-validates the uuid anyway.
// =============================================================================

import { useState } from "react";

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

export function UserPickerField({
  name,
  label,
  placeholder,
  initial,
}: {
  name: string;
  label: string;
  placeholder: string;
  initial: UserPickerOption | null;
}) {
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
