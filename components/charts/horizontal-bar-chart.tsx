// =============================================================================
// components/charts/horizontal-bar-chart.tsx — "aporte por nivel" and both
// Top 10 rankings (§8.5, D49). One component, because all three are the same
// question — who/how much contributed most — at different labels.
// =============================================================================

import { horizontalBars, type LayoutBox } from "@/lib/charts";

export interface RankingRow {
  label: string;
  /** Value in cents (for geometry only). */
  value: number;
  hint?: string;
}

const WIDTH = 720;
const ROW_HEIGHT = 30;
const LABEL_CHARS = 26;

function truncate(label: string): string {
  return label.length <= LABEL_CHARS ? label : `${label.slice(0, LABEL_CHARS - 1)}…`;
}

export function HorizontalBarChart({
  rows,
  formatValue,
  ariaLabel,
  emptyText,
}: {
  rows: readonly RankingRow[];
  formatValue: (value: number) => string;
  ariaLabel: string;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  const height = Math.max(60, rows.length * ROW_HEIGHT + 12);
  const box: LayoutBox = { width: WIDTH, height, padTop: 6, padRight: 120, padBottom: 6, padLeft: 200 };
  const bars = horizontalBars(
    rows.map((row) => row.value),
    box,
    { gap: 6 },
  );

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="h-auto w-full text-primary" role="img" aria-label={ariaLabel}>
      {bars.map((bar, index) => {
        const row = rows[index];
        return (
          <g key={`${row.label}-${index}`}>
            <text x={box.padLeft - 10} y={bar.y + bar.height / 2 + 4} textAnchor="end" fontSize={12} fill="currentColor" fillOpacity={0.75}>
              {truncate(row.label)}
            </text>
            <rect x={box.padLeft} y={bar.y} width={bar.width} height={bar.height} rx={3} fill="currentColor" fillOpacity={0.85}>
              <title>{`${row.label}: ${formatValue(row.value)}${row.hint ? ` · ${row.hint}` : ""}`}</title>
            </rect>
            <text
              x={box.padLeft + bar.width + 8}
              y={bar.y + bar.height / 2 + 4}
              fontSize={12}
              fill="currentColor"
              fillOpacity={0.75}
            >
              {formatValue(row.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
