// =============================================================================
// tests/charts.test.ts — the pure geometry behind the §8.5 SVG charts.
//
// These functions are the only place where chart maths happens, so these tests
// are what keeps the browser drawing what the dashboard decided.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  axisTicks,
  CHART_WINDOWS,
  heatColor,
  horizontalBars,
  linePoints,
  niceMax,
  percentLabel,
  plotSize,
  polyline,
  resolveChartWindow,
  scaleY,
  slotCenter,
  verticalBars,
  type LayoutBox,
} from "../lib/charts";

const BOX: LayoutBox = { width: 120, height: 100, padTop: 10, padRight: 10, padBottom: 10, padLeft: 10 };

describe("plotSize", () => {
  it("subtracts the padding from the full box", () => {
    expect(plotSize(BOX)).toEqual({ width: 100, height: 80 });
  });

  it("never returns a negative size", () => {
    expect(plotSize({ width: 10, height: 10, padTop: 20, padRight: 20, padBottom: 20, padLeft: 20 })).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe("niceMax", () => {
  it("returns 0 for zero or invalid input", () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(-5)).toBe(0);
    expect(niceMax(Number.NaN)).toBe(0);
  });

  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.4)).toBe(2);
    expect(niceMax(2)).toBe(2);
    expect(niceMax(3.4)).toBe(5);
    expect(niceMax(9)).toBe(10);
    expect(niceMax(1739)).toBe(2000);
    expect(niceMax(0.023)).toBeCloseTo(0.05, 10);
  });
});

describe("axisTicks", () => {
  it("splits the axis into count+1 round positions", () => {
    expect(axisTicks(100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("degrades to a single zero tick on an empty axis", () => {
    expect(axisTicks(0)).toEqual([0]);
    expect(axisTicks(-1)).toEqual([0]);
  });
});

describe("scaleY / slotCenter", () => {
  it("maps the max to the top of the plot and 0 to the baseline", () => {
    expect(scaleY(10, 10, BOX)).toBe(10); // plot top = padTop
    expect(scaleY(0, 10, BOX)).toBe(90); // plot bottom = height - padBottom
    expect(scaleY(5, 10, BOX)).toBe(50);
  });

  it("clamps values above the max to the top", () => {
    expect(scaleY(999, 10, BOX)).toBe(10);
  });

  it("centres each slot horizontally", () => {
    expect(slotCenter(0, 4, BOX)).toBe(22.5);
    expect(slotCenter(3, 4, BOX)).toBe(97.5);
  });
});

describe("verticalBars", () => {
  it("returns one rect per value, inside the plot", () => {
    const bars = verticalBars([0, 5, 10], BOX);

    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(BOX.padLeft);
      expect(bar.x + bar.width).toBeLessThanOrEqual(BOX.width - BOX.padRight + 0.001);
    }
  });

  it("scales heights proportionally to the axis max", () => {
    const bars = verticalBars([5, 10], BOX);
    // niceMax(10) = 10; the taller bar spans the full plot height (80).
    expect(bars[0].height).toBeCloseTo(40, 5);
    expect(bars[1].height).toBeCloseTo(80, 5);
  });

  it("draws a zero-height bar for zero and an empty array for no data", () => {
    expect(verticalBars([0], BOX)[0].height).toBe(0);
    expect(verticalBars([], BOX)).toEqual([]);
  });
});

describe("horizontalBars", () => {
  it("scales widths from 0 to the axis max", () => {
    const bars = horizontalBars([2.5, 5], BOX, { max: 5 });
    expect(bars[0].width).toBeCloseTo(50, 5);
    expect(bars[1].width).toBeCloseTo(100, 5);
  });

  it("separates rows by the gap, not by the row height alone", () => {
    const bars = horizontalBars([1, 1, 1], BOX, { gap: 8 });
    const [first, second] = bars;
    expect(second.y - first.y).toBeCloseTo(80 / 3, 5);
  });

  it("returns nothing for empty input or a zero box", () => {
    expect(horizontalBars([], BOX)).toEqual([]);
    expect(
      horizontalBars([1], { width: 0, height: 0, padTop: 0, padRight: 0, padBottom: 0, padLeft: 0 }),
    ).toEqual([]);
  });
});

describe("linePoints / polyline", () => {
  it("returns one point per value with the max at the plot top", () => {
    const points = linePoints([0, 10], 10, BOX);
    expect(points).toHaveLength(2);
    expect(points[1].y).toBe(10);
    expect(points[0].y).toBe(90);
  });

  it("renders a polyline attribute with rounded coordinates", () => {
    const points = linePoints([5, 10], 10, BOX);
    expect(polyline(points)).toBe("35,50 85,10");
    // Four slots put the first and last points at 1/8 and 7/8 of the plot.
    expect(polyline(linePoints([5, 0, 0, 10], 10, BOX))).toBe("22.5,50 47.5,90 72.5,90 97.5,10");
  });

  it("renders an empty attribute for no data", () => {
    expect(polyline(linePoints([], 10, BOX))).toBe("");
  });
});

describe("heatColor", () => {
  it("walks from red at 0 to green at 1", () => {
    expect(heatColor(0)).toBe("hsl(0 65% 45%)");
    expect(heatColor(0.5)).toBe("hsl(60 65% 45%)");
    expect(heatColor(1)).toBe("hsl(120 65% 45%)");
  });

  it("clamps out-of-range ratios and greys the missing ones", () => {
    expect(heatColor(3)).toBe("hsl(120 65% 45%)");
    expect(heatColor(-1)).toBe("hsl(0 65% 45%)");
    expect(heatColor(null)).toBe("hsl(220 10% 90%)");
  });
});

describe("percentLabel", () => {
  it("renders one decimal by default", () => {
    expect(percentLabel(1, 4)).toBe("25.0 %");
    expect(percentLabel(2, 3)).toBe("66.7 %");
  });

  it("renders 0 % when nobody owes, instead of dividing by zero", () => {
    expect(percentLabel(0, 0)).toBe("0.0 %");
    expect(percentLabel(3, 0)).toBe("0.0 %");
  });
});

describe("resolveChartWindow", () => {
  it("accepts exactly the three supported windows", () => {
    for (const window of CHART_WINDOWS) {
      expect(resolveChartWindow(String(window))).toBe(window);
      expect(resolveChartWindow(window)).toBe(window);
    }
  });

  it("falls back to 12 for anything else", () => {
    expect(resolveChartWindow("13")).toBe(12);
    expect(resolveChartWindow(undefined)).toBe(12);
    expect(resolveChartWindow("april")).toBe(12);
    expect(resolveChartWindow("26")).toBe(26);
  });
});
