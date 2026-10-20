// =============================================================================
// lib/export-presentation.ts — shared branding for the downloadable exports.
//
// The XLSX files and the print/PDF sheet are documents, not screens, so they
// cannot consume the app's CSS variables. The palette is pinned here as
// literals (D81) instead of being read from settings: the settings values are
// not the live UI palette, and the export routes run against narrow Prisma
// mocks where a settings read would fail.
//
// The helper is pure: given a title, a matrix and column widths it returns the
// exact `SheetData` that `write-excel-file` consumes. It never reads the
// database and never formats business data — the matrices remain the single
// source of truth for what a row says.
// =============================================================================

import type { Row, SheetData } from "write-excel-file/node";

import { dateLabel } from "./reports";

/** Brand name plus the D81 palette values shared with the live UI. */
export const EXPORT_BRAND = {
  name: "Red de Referidos",
  primary: "#2e67ff",
  foreground: "#0e142b",
  border: "#e7e4e4",
  background: "#fcfcfc",
  white: "#ffffff",
  zebra: "#f7f8fb",
} as const;

/** `DD/MM/YYYY HH:MM` local, so two generated files are comparable. */
export function exportStampLabel(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${dateLabel(date)} ${hours}:${minutes}`;
}

export interface PresentationSheetInput {
  title: string;
  subtitle: string;
  summary?: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  widths: readonly number[];
  /** 0-based indexes of the columns that hold numbers. */
  numericColumns?: readonly number[];
  footer?: string;
}

export interface PresentationSheet {
  data: SheetData;
  columns: { width: number }[];
  /** Freeze the header block: title, metadata, spacer and header stay visible. */
  stickyRowsCount: number;
}

/**
 * Builds the branded sheet every XLSX export shares:
 * title, subtitle, optional summary, header band, zebra data rows and an
 * optional footer. The matrix passed in is rendered verbatim.
 */
export function buildPresentationSheet(input: PresentationSheetInput): PresentationSheet {
  const { title, subtitle, summary, headers, rows, widths, numericColumns = [], footer } = input;
  const columnCount = headers.length;
  const numeric = new Set(numericColumns);
  const data: Row[] = [
    [
      {
        value: title,
        fontWeight: "bold",
        fontSize: 16,
        textColor: EXPORT_BRAND.primary,
        columnSpan: columnCount,
        height: 24,
      },
    ],
    [
      {
        value: subtitle,
        fontSize: 10,
        textColor: EXPORT_BRAND.foreground,
        columnSpan: columnCount,
      },
    ],
  ];

  if (summary !== undefined) {
    data.push([
      {
        value: summary,
        fontSize: 10,
        fontWeight: "bold",
        textColor: EXPORT_BRAND.foreground,
        columnSpan: columnCount,
      },
    ]);
  }

  // Spacer between the metadata block and the table.
  data.push([]);

  const headerRowIndex = data.length;
  data.push(
    headers.map((header) => ({
      value: header,
      fontWeight: "bold" as const,
      fontSize: 10,
      textColor: EXPORT_BRAND.white,
      backgroundColor: EXPORT_BRAND.primary,
      borderColor: EXPORT_BRAND.primary,
      borderStyle: "thin" as const,
      wrap: true,
      align: "center" as const,
      height: 28,
    })),
  );

  rows.forEach((cells, rowIndex) => {
    data.push(
      cells.map((value, cellIndex) => ({
        value,
        borderColor: EXPORT_BRAND.border,
        borderStyle: "thin" as const,
        backgroundColor: rowIndex % 2 === 0 ? EXPORT_BRAND.white : EXPORT_BRAND.zebra,
        align: numeric.has(cellIndex) ? ("right" as const) : ("left" as const),
      })),
    );
  });

  if (footer !== undefined) {
    data.push([]);
    data.push([
      {
        value: footer,
        fontSize: 9,
        textColor: EXPORT_BRAND.foreground,
        columnSpan: columnCount,
        wrap: true,
      },
    ]);
  }

  return {
    data,
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: headerRowIndex + 1,
  };
}
