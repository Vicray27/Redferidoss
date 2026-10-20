// =============================================================================
// tests/export-presentation.test.ts — the branded XLSX sheet builder.
//
// `buildPresentationSheet` is pure presentation: these tests pin the pieces the
// exports and the print page rely on (palette, sticky header block, zebra rows,
// numeric alignment and footer) without touching the matrices themselves.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { CellObject, Row } from "write-excel-file/node";

import {
  buildPresentationSheet,
  EXPORT_BRAND,
  exportStampLabel,
  type PresentationSheetInput,
} from "../lib/export-presentation";

const INPUT: PresentationSheetInput = {
  title: "Red de Referidos — Pagos",
  subtitle: "Filtros aplicados (2 filas)",
  summary: "Filas: 2",
  headers: ["Semana", "Nivel", "Monto"],
  rows: [
    ["2026-W42", "1", "10.05"],
    ["2026-W43", "2", "0.10"],
  ],
  widths: [12, 6, 10],
  numericColumns: [1, 2],
  footer: "Los montos son valores DECIMAL(14,2).",
};

function cell(row: Row | undefined, index: number): CellObject {
  return (row?.[index] ?? {}) as CellObject;
}

function headerIndex(data: Row[]): number {
  return data.findIndex(
    (row) => cell(row, 0).backgroundColor === EXPORT_BRAND.primary,
  );
}

describe("buildPresentationSheet", () => {
  it("maps the widths and freezes the block through the header row", () => {
    const sheet = buildPresentationSheet(INPUT);

    expect(sheet.columns).toEqual([{ width: 12 }, { width: 6 }, { width: 10 }]);
    const header = headerIndex(sheet.data);
    expect(header).toBeGreaterThan(-1);
    expect(sheet.stickyRowsCount).toBe(header + 1);
  });

  it("styles the title with the brand color and a full-width span", () => {
    const title = cell(buildPresentationSheet(INPUT).data[0], 0);

    expect(title.value).toBe(INPUT.title);
    expect(title.fontWeight).toBe("bold");
    expect(title.fontSize).toBe(16);
    expect(title.textColor).toBe(EXPORT_BRAND.primary);
    expect(title.columnSpan).toBe(INPUT.headers.length);
  });

  it("paints the header band primary with white bold wrapped text", () => {
    const data = buildPresentationSheet(INPUT).data;
    const header = data[headerIndex(data)];

    expect(header).toHaveLength(INPUT.headers.length);
    header.forEach((_, index) => {
      const headerCell = cell(header, index);
      expect(headerCell.value).toBe(INPUT.headers[index]);
      expect(headerCell.backgroundColor).toBe(EXPORT_BRAND.primary);
      expect(headerCell.textColor).toBe(EXPORT_BRAND.white);
      expect(headerCell.fontWeight).toBe("bold");
      expect(headerCell.wrap).toBe(true);
    });
  });

  it("zebra-stripes the data rows and right-aligns only numeric columns", () => {
    const data = buildPresentationSheet(INPUT).data;
    const first = headerIndex(data) + 1;

    expect(cell(data[first], 0).backgroundColor).toBe(EXPORT_BRAND.white);
    expect(cell(data[first + 1], 0).backgroundColor).toBe(EXPORT_BRAND.zebra);

    // 0 = Semana (text), 1 = Nivel, 2 = Monto (both numeric).
    expect(cell(data[first], 0).align).toBe("left");
    expect(cell(data[first], 1).align).toBe("right");
    expect(cell(data[first], 2).align).toBe("right");
    expect(cell(data[first + 1], 0).align).toBe("left");
  });

  it("adds the footer after a spacer row, and omits it when not provided", () => {
    const withFooter = buildPresentationSheet(INPUT);
    const footerRow = withFooter.data[withFooter.data.length - 1];
    const footer = cell(footerRow, 0);

    expect(footer.value).toBe(INPUT.footer);
    expect(footer.fontSize).toBe(9);
    expect(footer.columnSpan).toBe(INPUT.headers.length);
    expect(footer.wrap).toBe(true);
    expect(withFooter.data[withFooter.data.length - 2]).toEqual([]);

    const withoutFooter = buildPresentationSheet({ ...INPUT, footer: undefined });
    const lastRow = withoutFooter.data[withoutFooter.data.length - 1];
    expect(lastRow).toHaveLength(INPUT.headers.length);
    expect(cell(lastRow, 0).value).toBe("2026-W43");
  });
});

describe("exportStampLabel", () => {
  it("renders a local DD/MM/YYYY HH:MM stamp", () => {
    expect(exportStampLabel(new Date(2026, 9, 19, 9, 5))).toBe("19/10/2026 09:05");
  });
});
