"use client";

// =============================================================================
// components/network/network-search.tsx — find a person in my network (§12).
//
// One request per submitted term; typing does not query. The server scopes the
// search to the caller's subtree (alias `u` + scope fragment), so results can
// never be wider than the tree next to this box.
// =============================================================================

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import type { NetworkNode } from "@/lib/network";

export function NetworkSearch() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<NetworkNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/network/search?q=${encodeURIComponent(term)}`);
      const envelope = (await response.json()) as
        | { ok: true; data: { results: NetworkNode[] } }
        | { ok: false; error?: { message?: string } };

      if (!envelope.ok) throw new Error(envelope.error?.message ?? "No se pudo buscar.");
      setResults(envelope.data.results);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "No se pudo buscar.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Buscar por nombre o código…"
          aria-label="Buscar en mi red"
        />
        <Button type="submit" variant="outline" disabled={loading}>
          {loading ? "Buscando…" : "Buscar"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin resultados en tu red.</p>
        ) : (
          <ul className="divide-y rounded-md border bg-background">
            {results.map((node) => (
              <li key={node.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm">
                  {node.fullName}{" "}
                  <span className="font-mono text-xs text-muted-foreground">{node.publicCode}</span>
                </span>
                <Link className="text-xs underline" href={`/portal/network/${node.id}`}>
                  Ver ficha
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
