"use client";

// =============================================================================
// components/ui/tabs.tsx — accessible tabs without a dependency.
//
// WAI-ARIA tabs pattern: roving tabindex, arrow/Home/End navigation, one
// selected tab and every panel present but hidden. Panels stay mounted on
// purpose — a tab switch must never discard what a form already holds.
// =============================================================================

import * as React from "react";

import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  label: string;
  /** Optional count rendered as a pill (e.g. unsaved changes in that group). */
  badge?: number;
}

interface TabsContextValue {
  value: string;
  tabId: (id: string) => string;
  panelId: (id: string) => string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  children,
}: {
  items: readonly TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label: string;
  children: React.ReactNode;
}) {
  const baseId = React.useId();
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const tabId = React.useCallback((id: string) => `${baseId}-tab-${id}`, [baseId]);
  const panelId = React.useCallback((id: string) => `${baseId}-panel-${id}`, [baseId]);

  const focusTab = (index: number) => {
    const item = items[index];
    if (!item) return;
    onValueChange(item.id);
    tabRefs.current[index]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.id === value);
    if (current < 0) return;

    let next: number | null = null;
    if (event.key === "ArrowRight") next = (current + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;

    if (next === null) return;
    event.preventDefault();
    focusTab(next);
  };

  return (
    <TabsContext.Provider value={{ value, tabId, panelId }}>
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="flex flex-wrap items-center gap-1 rounded-lg border bg-background p-1"
        >
          {items.map((item, index) => {
            const selected = item.id === value;
            const badge = item.badge !== undefined && item.badge > 0 ? item.badge : null;

            return (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={tabId(item.id)}
                aria-selected={selected}
                aria-controls={panelId(item.id)}
                aria-label={badge ? `${item.label}, ${badge} cambios sin guardar` : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onValueChange(item.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
                {badge ? (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground/20 px-1.5 text-[10px] font-semibold">
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsPanel({
  id,
  children,
}: {
  /** Same id used in the matching `items` entry. */
  id: string;
  children: React.ReactNode;
}) {
  const context = React.useContext(TabsContext);
  if (context === null) {
    throw new Error("TabsPanel must be rendered inside Tabs");
  }

  const selected = context.value === id;

  return (
    <div
      role="tabpanel"
      id={context.panelId(id)}
      aria-labelledby={context.tabId(id)}
      hidden={!selected}
      tabIndex={0}
      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {children}
    </div>
  );
}
