// =============================================================================
// lib/charts.ts — deterministic geometry for the §8.5 dependency-free charts.
//
// The dashboard's five charts are server-rendered SVG: no charting library, no
// client JavaScript, no canvas. That choice (D49) moves every interesting
// number out of a component and into these pure functions, so the shapes the
// tests pin are the shapes the browser draws.
//
// WHY PURE FUNCTIONS AND NOT JSX
// ------------------------------
// A component that computes its own bar heights can only be verified by
// rendering it, and this repo has no React test harness. A function that maps
// values + a layout box to coordinates is unit-testable, deterministic and
// reusable across the five different chart faces. The components stay thin
// enough to review by eye; the maths does not.
//
// MONEY SAFETY
// ------------
// Geometry needs `number`, but money arrives as exact BigInt cents (A14). The
// conversion happens at the CALLER (the page), which reads a DECIMAL string
// through lib/money.ts first, and only for the purpose of drawing: the exact
// string is what every label renders. Numbers here are pixel-ish quantities,
// never balances.
// =============================================================================

export interface LayoutBox {
  /** Full SVG box, in user units (viewBox coordinates). */
  width: number;
  height: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
}

/** The drawable area inside the padding. */
export function plotSize(box: LayoutBox): { width: number; height: number } {
  return {
    width: Math.max(0, box.width - box.padLeft - box.padRight),
    height: Math.max(0, box.height - box.padTop - box.padBottom),
  };
}

/**
 * Smallest "nice" number >= value: 1, 2, 5 × 10^n.
 *
 * A bar chart whose tallest bar touches the ceiling with a value like 1739
 * needs a 2000 axis, not a 1739 one: the gridlines must land on round numbers
 * for the chart to be readable.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Round gridline values from 0 to `max`, `count` intervals. */
export function axisTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0 || count < 1) return [0];
  const ticks: number[] = [];
  for (let index = 0; index <= count; index += 1) ticks.push((max * index) / count);
  return ticks;
}

/** X position of the `index`-th of `count` slots, centred in its slot. */
export function slotCenter(index: number, count: number, box: LayoutBox): number {
  const { width } = plotSize(box);
  if (count <= 0) return box.padLeft + width / 2;
  const slot = width / count;
  return box.padLeft + slot * index + slot / 2;
}

/** Y position of `value` on a 0..`max` axis (0 at the bottom of the plot). */
export function scaleY(value: number, max: number, box: LayoutBox): number {
  const { height } = plotSize(box);
  const top = box.height - box.padBottom;
  if (max <= 0 || !Number.isFinite(value)) return top;
  const clamped = Math.min(Math.max(value, 0), max);
  return top - (clamped / max) * height;
}

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Vertical bars, one per value, scaled to `max` (default: `niceMax(max(values))`).
 * A zero value gets a zero-height bar; the minimum visible height is the
 * caller's decision, not this function's.
 */
export function verticalBars(
  values: readonly number[],
  box: LayoutBox,
  options: { max?: number; gapRatio?: number } = {},
): BarRect[] {
  const max = options.max ?? niceMax(Math.max(0, ...values));
  const gapRatio = options.gapRatio ?? 0.3;
  const { width, height } = plotSize(box);
  const count = values.length;
  if (count === 0 || width <= 0 || height <= 0) return [];
  const slot = width / count;
  const barWidth = Math.max(1, slot * (1 - gapRatio));
  const baseline = box.height - box.padBottom;

  return values.map((value, index) => {
    const top = scaleY(value, max, box);
    return {
      x: box.padLeft + slot * index + (slot - barWidth) / 2,
      y: top,
      width: barWidth,
      height: Math.max(0, baseline - top),
    };
  });
}

/**
 * Horizontal bars (one per value) with width proportional to value/max.
 * Used by the "aporte por nivel" chart and the Top-10 rankings.
 */
export function horizontalBars(
  values: readonly number[],
  box: LayoutBox,
  options: { max?: number; gap?: number } = {},
): BarRect[] {
  const max = options.max ?? niceMax(Math.max(0, ...values));
  const gap = options.gap ?? 4;
  const { width, height } = plotSize(box);
  const count = values.length;
  if (count === 0 || width <= 0 || height <= 0) return [];
  const slot = height / count;
  const barHeight = Math.max(1, slot - gap);

  return values.map((value, index) => {
    const ratio = max <= 0 || !Number.isFinite(value) ? 0 : Math.min(Math.max(value / max, 0), 1);
    return {
      x: box.padLeft,
      y: box.padTop + slot * index + (slot - barHeight) / 2,
      width: Math.max(0, ratio * width),
      height: barHeight,
    };
  });
}

export interface Point {
  x: number;
  y: number;
}

/** One point per value on a 0..`max` axis, horizontally spread across the plot. */
export function linePoints(values: readonly number[], max: number, box: LayoutBox): Point[] {
  const count = values.length;
  if (count === 0) return [];
  return values.map((value, index) => ({
    x: slotCenter(index, count, box),
    y: scaleY(value, max, box),
  }));
}

/** `points` attribute for an SVG <polyline>. */
export function polyline(points: readonly Point[]): string {
  return points.map((point) => `${round(point.x)},${round(point.y)}`).join(" ");
}

/** One decimal is plenty at pixel scale; keeps SSR output stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Heatmap colour: red at 0, green at 1, through amber at 0.5.
 * `hsl` with a fixed saturation/lightness keeps contrast readable on both the
 * printed page and the screen, and the value is deterministic for the tests.
 */
export function heatColor(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "hsl(220 10% 90%)";
  const clamped = Math.min(Math.max(ratio, 0), 1);
  const hue = Math.round(clamped * 120);
  return `hsl(${hue} 65% 45%)`;
}

/** `78.4 %`-style label; `0 %` when the denominator is empty. */
export function percentLabel(numerator: number, denominator: number, decimals = 1): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return `${(0).toFixed(decimals)} %`;
  }
  return `${((numerator / denominator) * 100).toFixed(decimals)} %`;
}

/** The five window sizes the §8.5 bar chart offers (D49). */
export const CHART_WINDOWS = [12, 26, 52] as const;
export type ChartWindow = (typeof CHART_WINDOWS)[number];

/**
 * Coerce anything to a supported window. An unknown value falls back to the
 * default instead of throwing: the window is a display choice in the URL, and
 * a hand-edited query string must not break the page.
 */
export function resolveChartWindow(raw: unknown, fallback: ChartWindow = 12): ChartWindow {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return (CHART_WINDOWS as readonly number[]).includes(value) ? (value as ChartWindow) : fallback;
}
