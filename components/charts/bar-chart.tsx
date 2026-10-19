"use client";

// =============================================================================
// components/charts/bar-chart.tsx — "monto aprobado por semana" (§8.5, D75).
//
// Client ECharts rendering. Every amount reaching this component is already a
// display string built on the server with formatAmount; the numeric `value`
// (cents) only feeds the geometry. The y-axis divides cents by 100 for the
// ticks — display only, never money arithmetic.
// =============================================================================

import type { EChartsOption } from "echarts";

import { dataIndexOf, EChart } from "@/components/charts/echart";

export interface BarPoint {
  label: string;
  /** Value in cents (for geometry only). */
  value: number;
  /** Pre-formatted amount, built on the server. */
  valueLabel: string;
  hint?: string;
}

const BAR_COLOR = "hsl(var(--primary))";
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const SPLIT_LINE = "hsl(var(--border))";

export function BarChart({
  points,
  ariaLabel,
  emptyText,
}: {
  points: readonly BarPoint[];
  ariaLabel: string;
  emptyText?: string;
}) {
  if (points.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        {emptyText ?? "Aún no hay semanas para graficar."}
      </p>
    );
  }

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: { left: 60, right: 16, top: 16, bottom: 30 },
    tooltip: {
      trigger: "item",
      backgroundColor: "#fff",
      borderColor: SPLIT_LINE,
      textStyle: { color: "hsl(var(--foreground))" },
      formatter: (params: unknown) => {
        const point = points[dataIndexOf(params)];
        if (!point) return "";
        return `${point.label}: ${point.valueLabel}${point.hint ? ` · ${point.hint}` : ""}`;
      },
    },
    xAxis: {
      type: "category",
      data: points.map((point) => point.label),
      axisLine: { lineStyle: { color: SPLIT_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: AXIS_TEXT,
        fontSize: 11,
        // Ticks are cents in the data; the axis shows currency units.
        formatter: (value: number) => (value / 100).toFixed(2),
      },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
    },
    series: [
      {
        type: "bar",
        name: "Aprobado",
        data: points.map((point) => point.value),
        barMaxWidth: 28,
        itemStyle: { color: BAR_COLOR, borderRadius: [2, 2, 0, 0] },
      },
    ],
  };

  return <EChart option={option} height={240} ariaLabel={ariaLabel} />;
}
