"use client";

// =============================================================================
// components/charts/horizontal-bar-chart.tsx — "aporte por nivel" and both
// Top 10 rankings (§8.5, D75). One component, because all three are the same
// question — who/how much contributed most — at different labels.
// =============================================================================

import type { EChartsOption } from "echarts";

import { dataIndexOf, EChart } from "@/components/charts/echart";

export interface RankingRow {
  label: string;
  /** Value in cents (for geometry only). */
  value: number;
  /** Pre-formatted amount, built on the server. */
  valueLabel: string;
  hint?: string;
}

const ROW_HEIGHT = 30;
const BAR_COLOR = "hsl(var(--primary))";
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const SPLIT_LINE = "hsl(var(--border))";

export function HorizontalBarChart({
  rows,
  ariaLabel,
  emptyText,
}: {
  rows: readonly RankingRow[];
  ariaLabel: string;
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        {emptyText ?? "Sin datos para graficar."}
      </p>
    );
  }

  const height = Math.max(80, rows.length * ROW_HEIGHT + 16);

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: { left: 210, right: 92, top: 8, bottom: 8 },
    tooltip: {
      trigger: "item",
      backgroundColor: "#fff",
      borderColor: SPLIT_LINE,
      textStyle: { color: "hsl(var(--foreground))" },
      formatter: (params: unknown) => {
        const row = rows[dataIndexOf(params)];
        if (!row) return "";
        return `${row.label}: ${row.valueLabel}${row.hint ? ` · ${row.hint}` : ""}`;
      },
    },
    xAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => row.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 12, width: 190, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        name: "Aprobado",
        data: rows.map((row) => ({
          value: row.value,
          label: {
            show: true,
            position: "right" as const,
            color: AXIS_TEXT,
            fontSize: 12,
            formatter: row.valueLabel,
          },
        })),
        barMaxWidth: 18,
        itemStyle: { color: BAR_COLOR, borderRadius: [0, 3, 3, 0] },
      },
    ],
  };

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
