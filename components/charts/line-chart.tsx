// =============================================================================
// components/charts/line-chart.tsx — "nº de reportes vs. obligaciones por
// semana" (§8.5, D49). Server-rendered SVG, two polylines.
// =============================================================================

import { axisTicks, linePoints, niceMax, polyline, scaleY, type LayoutBox } from "@/lib/charts";

export interface LineSeries {
  name: string;
  /** Tailwind text-* class; the stroke follows currentColor. */
  className: string;
  values: readonly number[];
}

const WIDTH = 720;
const HEIGHT = 220;
const BOX: LayoutBox = { width: WIDTH, height: HEIGHT, padTop: 16, padRight: 8, padBottom: 28, padLeft: 44 };

export function LineChart({
  labels,
  series,
  ariaLabel,
}: {
  labels: readonly string[];
  series: readonly LineSeries[];
  ariaLabel: string;
}) {
  const allValues = series.flatMap((item) => [...item.values]);
  if (labels.length === 0 || allValues.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        Aún no hay semanas para graficar.
      </p>
    );
  }

  const max = niceMax(Math.max(...allValues, 1));
  const baseline = BOX.height - BOX.padBottom;
  const ticks = axisTicks(max, 3);
  const labelEvery = Math.max(1, Math.ceil(labels.length / 13));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((item) => (
          <span key={item.name} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-0.5 w-4 rounded bg-current ${item.className}`} />
            {item.name}
          </span>
        ))}
      </div>

      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((tick) => {
          const y = scaleY(tick, max, BOX);
          return (
            <g key={tick}>
              <line x1={BOX.padLeft} x2={WIDTH - BOX.padRight} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.12} />
              <text x={BOX.padLeft - 8} y={y + 4} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.6}>
                {tick}
              </text>
            </g>
          );
        })}

        {series.map((item) => {
          const points = linePoints([...item.values], max, BOX);
          return (
            <g key={item.name} className={item.className}>
              <polyline
                points={polyline(points)}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
              >
                <title>{`${item.name}: ${item.values.join(" · ")}`}</title>
              </polyline>
              {points.map((point, index) =>
                (item.values[index] ?? 0) > 0 ? (
                  <circle key={index} cx={point.x} cy={point.y} r={2.5} fill="currentColor" />
                ) : null,
              )}
            </g>
          );
        })}

        {labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text
              key={`${label}-${index}`}
              x={BOX.padLeft + (index + 0.5) * ((WIDTH - BOX.padLeft - BOX.padRight) / labels.length)}
              y={HEIGHT - 10}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
              fillOpacity={0.6}
            >
              {label}
            </text>
          ) : null,
        )}

        <line
          x1={BOX.padLeft}
          x2={WIDTH - BOX.padRight}
          y1={baseline}
          y2={baseline}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
      </svg>
    </div>
  );
}
