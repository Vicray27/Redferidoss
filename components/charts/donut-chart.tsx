"use client";

// =============================================================================
// components/charts/donut-chart.tsx — "participación de la semana" (D75).
//
// A ring (pie with an inner radius) for two complementary counts, e.g. who
// reported and who did not. Values are plain counts pre-labelled on the server.
// =============================================================================

import type { EChartsOption } from "echarts";

import { dataIndexOf, EChart } from "@/components/charts/echart";

export interface DonutSlice {
  name: string;
  value: number;
  /** Pre-formatted count/label, built on the server. */
  valueLabel: string;
}

// First slice: the brand royal tone. Second: its lighter step.
const SLICE_COLORS = ["hsl(var(--primary))", "hsl(239.3, 40%, 75%)"];
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const SPLIT_LINE = "hsl(var(--border))";

export function DonutChart({
  slices,
  ariaLabel,
  emptyText,
}: {
  slices: readonly DonutSlice[];
  ariaLabel: string;
  emptyText?: string;
}) {
  const hasData = slices.length > 0 && slices.some((slice) => slice.value > 0);
  if (!hasData) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        {emptyText ?? "Sin datos para graficar."}
      </p>
    );
  }

  const option: EChartsOption = {
    aria: { enabled: true },
    tooltip: {
      trigger: "item",
      backgroundColor: "#fff",
      borderColor: SPLIT_LINE,
      textStyle: { color: "hsl(var(--foreground))" },
      formatter: (params: unknown) => {
        const slice = slices[dataIndexOf(params)];
        if (!slice) return "";
        return `${slice.name}: ${slice.valueLabel}`;
      },
    },
    legend: {
      bottom: 0,
      icon: "circle",
      textStyle: { color: AXIS_TEXT, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["52%", "74%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        // Outside labels are clipped by the 240px canvas edge; the legend,
        // tooltip and stat cards already carry the same names and counts.
        label: { show: false },
        labelLine: { show: false },
        data: slices.map((slice, index) => ({
          name: slice.name,
          value: slice.value,
          itemStyle: { color: SLICE_COLORS[index] ?? SLICE_COLORS[SLICE_COLORS.length - 1] },
        })),
      },
    ],
  };

  return <EChart option={option} height={240} ariaLabel={ariaLabel} />;
}
