"use client";

// =============================================================================
// components/charts/echart.tsx — the single client entry point for ECharts.
//
// The chart wrappers (bar, line, horizontal bar, donut) build a serializable
// EChartsOption on the client from props the server already formatted. This
// component owns the imperative part: resolving the theme tokens from the CSS
// custom properties, initialising the instance, resizing it and disposing it.
//
// Colors are resolved inside the effect because `getComputedStyle` only exists
// in the browser. Options use `hsl(var(--token))` placeholders; they are
// rewritten to comma-separated `hsl()` before reaching ECharts, whose color
// parser does not understand the modern space-separated syntax.
// =============================================================================

import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";
import { LineChart as ELineChart, BarChart as EBarChart, PieChart as EPieChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  EBarChart,
  ELineChart,
  EPieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  CanvasRenderer,
]);

/** Stable fallbacks in case the stylesheet has not loaded yet. */
const TOKEN_FALLBACKS: Record<string, string> = {
  "--primary": "223.6 100% 59%",
  "--foreground": "227.6 50.9% 11.2%",
  "--muted-foreground": "227.6 50.9% 11.2%",
  "--border": "0 5.9% 90%",
};

const TOKEN_COLOR = /^hsl\(var\((--[a-z-]+)\)\)$/;

function readToken(styles: CSSStyleDeclaration, token: string): string {
  const raw = styles.getPropertyValue(token).trim() || TOKEN_FALLBACKS[token] || "0 0% 0%";
  // zrender (ECharts' renderer) only parses `hsl(h, s%, l%)`.
  return `hsl(${raw.split(/\s+/).join(", ")})`;
}

function resolveTokens(value: unknown, styles: CSSStyleDeclaration): unknown {
  if (typeof value === "string") {
    const match = TOKEN_COLOR.exec(value);
    return match ? readToken(styles, match[1]) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTokens(entry, styles));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveTokens(entry, styles)]),
    );
  }
  return value;
}

export interface EChartProps {
  option: EChartsOption;
  height: number;
  ariaLabel: string;
  className?: string;
}

export function EChart({ option, height, ariaLabel, className }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = echarts.init(container);
    chartRef.current = chart;

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      chartRef.current = null;
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const styles = getComputedStyle(document.documentElement);
    chart.setOption(resolveTokens(option, styles) as EChartsOption, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ height }}
    />
  );
}

/**
 * ECharts hands formatters the hovered point (or an array on axis triggers).
 * Our formatters only need `dataIndex` to look up the server-formatted label.
 */
export function dataIndexOf(params: unknown): number {
  const first = Array.isArray(params) ? params[0] : params;
  if (first === null || typeof first !== "object" || !("dataIndex" in first)) return -1;
  const index = (first as { dataIndex?: unknown }).dataIndex;
  return typeof index === "number" ? index : -1;
}
