// =============================================================================
// components/charts/compliance-heatmap.tsx — "mapa de calor de cumplimiento
// (semanas × niveles)" (§8.5, D49/D50).
//
// A CSS grid rather than SVG: the cells are interactive targets (title text
// plus the drill-down link on /admin/cumplimiento) and a grid keeps them
// accessible as table-like content. heatColor() stays the single palette.
// =============================================================================

import { heatColor, percentLabel } from "@/lib/charts";

interface HeatmapCellInput {
  periodKey: string;
  level: number;
  approved: number;
  obligations: number;
}

/** "2026-W42" -> "42"; the column header keeps the year in the table caption. */
export function shortPeriodKey(periodKey: string): string {
  const match = /-W(\d+)$/.exec(periodKey);
  return match ? match[1] : periodKey;
}

export function ComplianceHeatmap({
  periodKeys,
  levels,
  cells,
}: {
  periodKeys: readonly string[];
  levels: readonly number[];
  cells: readonly HeatmapCellInput[];
}) {
  if (periodKeys.length === 0 || levels.length === 0) {
    return (
      <p className="rounded-lg border border-dashed bg-background p-6 text-sm text-muted-foreground">
        Aún no hay obligaciones registradas en la ventana.
      </p>
    );
  }

  const byKey = new Map(cells.map((cell) => [`${cell.level}:${cell.periodKey}`, cell]));
  const labelEvery = Math.max(1, Math.ceil(periodKeys.length / 13));
  const gridTemplate = `repeat(${periodKeys.length}, minmax(1.25rem, 1fr))`;

  return (
    <div className="overflow-x-auto rounded-lg border bg-background p-4">
      <div className="min-w-max space-y-1">
        <div className="grid items-end gap-1" style={{ gridTemplateColumns: `3rem ${gridTemplate}` }}>
          <span />
          {periodKeys.map((periodKey, index) => (
            <span key={periodKey} className="text-center text-[10px] text-muted-foreground">
              {index % labelEvery === 0 ? shortPeriodKey(periodKey) : ""}
            </span>
          ))}
        </div>

        {levels.map((level) => (
          <div key={level} className="grid items-center gap-1" style={{ gridTemplateColumns: `3rem ${gridTemplate}` }}>
            <span className="pr-2 text-right text-[10px] text-muted-foreground">Nivel {level}</span>
            {periodKeys.map((periodKey) => {
              const cell = byKey.get(`${level}:${periodKey}`);
              const obligations = cell?.obligations ?? 0;
              const approved = cell?.approved ?? 0;
              const ratio = obligations > 0 ? approved / obligations : null;
              const label = `${periodKey} · nivel ${level}: ${approved}/${obligations} (${percentLabel(approved, obligations, 0)})`;
              return (
                <span
                  key={periodKey}
                  title={label}
                  aria-label={label}
                  className="h-5 rounded-sm border border-black/5"
                  style={{ backgroundColor: heatColor(ratio) }}
                />
              );
            })}
          </div>
        ))}

        <div className="grid gap-1 pt-1" style={{ gridTemplateColumns: `3rem ${gridTemplate}` }}>
          <span />
          <span className="col-span-full text-[10px] text-muted-foreground">
            Cumplimiento por semana y nivel (verde: aprobado · ámbar: parcial · rojo: sin aprobar ·
            gris: sin obligaciones). Columna «{shortPeriodKey(periodKeys[0])}» a «
            {shortPeriodKey(periodKeys[periodKeys.length - 1])}».
          </span>
        </div>
      </div>
    </div>
  );
}
