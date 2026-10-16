// =============================================================================
// components/charts/bar-chart.tsx — "monto aprobado por semana" (§8.5, D49).
//
// A server component: the SVG is produced once on the server with the pure
// geometry of lib/charts.ts, so the chart exists even with JavaScript off and
// needs no hydration. `formatValue` renders the money labels — the amounts
// themselves stay exact cents upstream and only become `number` for drawing.
// =============================================================================

import {
  axisTicks,
  niceMax,
  slotCenter,
  scaleY,
  verticalBars,
  type LayoutBox,
} from "@/lib/charts";

export interface BarPoint {
  label: string;
  /** Value in cents (for geometry only). */
  value: number;
  hint?: string;
}

const WIDTH = 720;
const HEIGHT = 220;
const BOX: LayoutBox = { width: WIDTH, height: HEIGHT, padTop: 16, padRight: 8, padBottom: 28, padLeft: 64 };

export function BarChart({
  points,
  formatValue,
  ariaLabel,
}: {
  points: readonly BarPoint[];
  formatValue: (value: number) => string;
  ariaLabel: string;
}) {
  if (points.length === 0) {
    return <EmptyChart>Aún no hay semanas para graficar.</EmptyChart>;
  }

  const max = niceMax(Math.max(...points.map((point) => point.value), 0));
  const baseline = BOX.height - BOX.padBottom;
  const ticks = axisTicks(max, 3);
  const bars = verticalBars(
    points.map((point) => point.value),
    BOX,
    { max, gapRatio: 0.4 },
  );
  // With 52 weeks the labels would collide: every k-th stays, k is whatever
  // keeps at most ~13 labels on screen.
  const labelEvery = Math.max(1, Math.ceil(points.length / 13));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full text-primary" role="img" aria-label={ariaLabel}>
      {ticks.map((tick) => {
        const y = scaleY(tick, max, BOX);
        return (
          <g key={tick}>
            <line x1={BOX.padLeft} x2={WIDTH - BOX.padRight} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.12} />
            <text x={BOX.padLeft - 8} y={y + 4} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.6}>
              {formatValue(tick)}
            </text>
          </g>
        );
      })}

      {points.map((point, index) => {
        const bar = bars[index];
        const x = slotCenter(index, points.length, BOX);
        return (
          <g key={`${point.label}-${index}`}>
            <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={2} fill="currentColor" fillOpacity={0.85}>
              <title>{`${point.label}: ${formatValue(point.value)}${point.hint ? ` · ${point.hint}` : ""}`}</title>
            </rect>
            {index % labelEvery === 0 ? (
              <text x={x} y={HEIGHT - 10} textAnchor="middle" fontSize={11} fill="currentColor" fillOpacity={0.6}>
                {point.label}
              </text>
            ) : null}
          </g>
        );
      })}

      <line
        x1={BOX.padLeft}
        x2={WIDTH - BOX.padRight}
        y1={baseline}
        y2={baseline}
        stroke="currentColor"
        strokeOpacity={0.4}
      />
    </svg>
  );
}

export function EmptyChart({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
