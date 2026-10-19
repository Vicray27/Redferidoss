"use client";

// =============================================================================
// components/charts/line-chart.tsx — "nº de reportes vs. obligaciones por
// semana" (§8.5, D75). Client ECharts rendering, two plain line series.
// =============================================================================

import type { EChartsOption } from "echarts";

import { EChart } from "@/components/charts/echart";

export type LineSeriesColor = "primary" | "secondary";

export interface LineSeries {
  name: string;
  values: readonly number[];
  color?: LineSeriesColor;
}

const SERIES_COLORS: Record<LineSeriesColor, string> = {
  primary: "hsl(var(--primary))",
  secondary: "hsl(223.6, 60%, 62%)",
};
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const SPLIT_LINE = "hsl(var(--border))";

export function LineChart({
  labels,
  series,
  ariaLabel,
  emptyText,
}: {
  labels: readonly string[];
  series: readonly LineSeries[];
  ariaLabel: string;
  emptyText?: string;
}) {
  const allValues = series.flatMap((item) => [...item.values]);
  if (labels.length === 0 || allValues.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        {emptyText ?? "Aún no hay semanas para graficar."}
      </p>
    );
  }

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: { left: 48, right: 16, top: 34, bottom: 30 },
    legend: {
      top: 0,
      left: 0,
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 3,
      textStyle: { color: AXIS_TEXT, fontSize: 12 },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#fff",
      borderColor: SPLIT_LINE,
      textStyle: { color: "hsl(var(--foreground))" },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: [...labels],
      axisLine: { lineStyle: { color: SPLIT_LINE } },
      axisTick: { show: false },
      axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
    },
    series: series.map((item) => {
      const color = SERIES_COLORS[item.color ?? "primary"];
      return {
        type: "line",
        name: item.name,
        data: [...item.values],
        symbol: "circle",
        symbolSize: 5,
        itemStyle: { color },
        lineStyle: { color, width: 2 },
      };
    }),
  };

  return <EChart option={option} height={240} ariaLabel={ariaLabel} />;
}
