"use client";

// =============================================================================
// components/network/network-tree.tsx — the lazy tree of §12.
//
// One node expands into a request: `GET /api/network/children?parentId=…`.
// Nothing is preloaded, the scope filter runs on every call, and a MEMBER's
// children endpoint simply never returns rows outside their subtree — the
// component does not filter, it ASKS (§7.1: prohibited to filter in the
// client).
//
// Pagination is keyset: when the server answers with `nextCursor`, the node
// shows "Cargar más" instead of pretending the list is complete.
//
// Status chip is the USER state (Activo / Pendiente). The §12 "cycle payment"
// chip needs the payments domain (F4) and arrives with it; inventing a color
// from data that does not exist yet would be worse than its absence.
// =============================================================================

import { useState } from "react";

import type { NetworkNode } from "@/lib/network";

interface NodeState {
  nodes: NetworkNode[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  ACTIVE: { text: "Activo", className: "bg-emerald-100 text-emerald-800" },
  PENDING: { text: "Pendiente", className: "bg-amber-100 text-amber-800" },
  SUSPENDED: { text: "Suspendido", className: "bg-red-100 text-red-800" },
  INACTIVE: { text: "Inactivo", className: "bg-muted text-muted-foreground" },
};

export function NetworkTree({
  rootId,
  rootDepth,
  initialChildren,
  initialNextCursor,
}: {
  rootId: string;
  rootDepth: number;
  initialChildren: NetworkNode[];
  initialNextCursor: string | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([rootId]));
  const [states, setStates] = useState<Record<string, NodeState>>({
    [rootId]: {
      nodes: initialChildren,
      nextCursor: initialNextCursor,
      loaded: true,
      loading: false,
      error: null,
    },
  });

  const fetchPage = async (nodeId: string, cursor: string | null, append: boolean) => {
    setStates((current) => ({
      ...current,
      [nodeId]: {
        ...(current[nodeId] ?? { nodes: [], nextCursor: null, loaded: false, error: null }),
        loading: true,
        error: null,
      },
    }));

    try {
      const params = new URLSearchParams({ parentId: nodeId, limit: "25" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/network/children?${params.toString()}`);
      const envelope = (await response.json()) as
        | { ok: true; data: { nodes: NetworkNode[]; nextCursor: string | null } }
        | { ok: false; error?: { message?: string } };

      if (!envelope.ok) {
        throw new Error(envelope.error?.message ?? "No se pudo cargar la red.");
      }

      setStates((current) => {
        const previous = current[nodeId];
        return {
          ...current,
          [nodeId]: {
            nodes: append && previous ? [...previous.nodes, ...envelope.data.nodes] : envelope.data.nodes,
            nextCursor: envelope.data.nextCursor,
            loaded: true,
            loading: false,
            error: null,
          },
        };
      });
    } catch (error) {
      setStates((current) => ({
        ...current,
        [nodeId]: {
          ...(current[nodeId] ?? { nodes: [], nextCursor: null, loaded: false }),
          loading: false,
          error: error instanceof Error ? error.message : "No se pudo cargar la red.",
        },
      }));
    }
  };

  const toggle = (node: NetworkNode) => {
    const isOpen = expanded.has(node.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(node.id);
      else next.add(node.id);
      return next;
    });

    const state = states[node.id];
    if (!isOpen && (!state || !state.loaded) && node.childrenCount > 0) {
      void fetchPage(node.id, null, false);
    }
  };

  return (
    <div className="space-y-1" role="tree" aria-label="Mi red de referidos">
      {states[rootId]?.nodes.length === 0 && states[rootId]?.loaded ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Todavía no tienes referidos en tu red.
        </p>
      ) : null}

      {states[rootId]?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {states[rootId]?.error}
        </p>
      ) : null}

      {(states[rootId]?.nodes ?? []).map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          rootDepth={rootDepth}
          expanded={expanded}
          states={states}
          onToggle={toggle}
          onLoadMore={(id, cursor) => void fetchPage(id, cursor, true)}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  rootDepth,
  expanded,
  states,
  onToggle,
  onLoadMore,
}: {
  node: NetworkNode;
  rootDepth: number;
  expanded: Set<string>;
  states: Record<string, NodeState>;
  onToggle: (node: NetworkNode) => void;
  onLoadMore: (nodeId: string, cursor: string) => void;
}) {
  const state = states[node.id];
  const isOpen = expanded.has(node.id);
  const indent = Math.max(0, node.depth - rootDepth - 1) * 20;
  const status = STATUS_LABEL[node.status] ?? {
    text: node.status,
    className: "bg-muted text-muted-foreground",
  };

  return (
    <div role="treeitem" aria-expanded={isOpen}>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2"
        style={{ marginLeft: indent }}
      >
        {node.childrenCount > 0 ? (
          <button
            type="button"
            aria-label={isOpen ? `Contraer ${node.fullName}` : `Expandir ${node.fullName}`}
            className="h-6 w-6 rounded border text-xs leading-none"
            onClick={() => onToggle(node)}
          >
            {isOpen ? "−" : "+"}
          </button>
        ) : (
          <span className="h-6 w-6 text-center text-xs leading-6 text-muted-foreground">·</span>
        )}

        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.fullName}</span>
        <span className="font-mono text-xs text-muted-foreground">{node.publicCode}</span>

        <span className={`rounded-full px-2 py-0.5 text-xs ${status.className}`}>{status.text}</span>

        {node.childrenCount > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {node.childrenCount} referido{node.childrenCount === 1 ? "" : "s"}
          </span>
        ) : null}

        <a className="text-xs underline" href={`/portal/network/${node.id}`}>
          Ver ficha
        </a>
      </div>

      {isOpen ? (
        <div>
          {state?.loading ? <p className="py-1 text-xs text-muted-foreground">Cargando…</p> : null}
          {state?.error ? (
            <p role="alert" className="py-1 text-xs text-destructive">
              {state.error}
            </p>
          ) : null}
          {(state?.nodes ?? []).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              rootDepth={rootDepth}
              expanded={expanded}
              states={states}
              onToggle={onToggle}
              onLoadMore={onLoadMore}
            />
          ))}
          {state?.nextCursor ? (
            <button
              type="button"
              className="ml-6 py-1 text-xs underline"
              onClick={() => onLoadMore(node.id, state.nextCursor as string)}
            >
              Cargar más
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
