"use client";

// =============================================================================
// app/portal/semana/week-tabs.tsx — mobile-first switch between the offering
// form and the weekly report.
//
// The two forms are independent (D4/D44) but a phone cannot show both at once
// without a long scroll. Tabs keep BOTH panels mounted (components/ui/tabs.tsx),
// so switching never discards what the member already typed.
// =============================================================================

import { useState, type ReactNode } from "react";

import { Tabs, TabsPanel } from "@/components/ui/tabs";

const TAB_ITEMS = [
  { id: "aporte", label: "Aporte" },
  { id: "asistencia", label: "Asistencia" },
] as const;

export function WeekTabs({
  defaultTab,
  payment,
  week,
}: {
  defaultTab: "aporte" | "asistencia";
  payment: ReactNode;
  week: ReactNode;
}) {
  const [value, setValue] = useState<string>(defaultTab);

  return (
    // The primitive keeps its own markup; these variants only make both
    // triggers fill the row and meet the 44px touch target on phones.
    <div className="[&_[role=tab]]:min-h-11 [&_[role=tab]]:flex-1">
      <Tabs
        items={TAB_ITEMS}
        value={value}
        onValueChange={setValue}
        label="Aporte y asistencia de la semana"
      >
        <TabsPanel id="aporte">{payment}</TabsPanel>
        <TabsPanel id="asistencia">{week}</TabsPanel>
      </Tabs>
    </div>
  );
}
