// =============================================================================
// tests/multi-select.test.ts — the pure logic of the searchable multi-select
// (components/ui/multi-select.tsx): local search over the human label and the
// raw key, and the summary copy that keeps the applied filter visible.
//
// No DOM and no testing-library: the interactive parts are plain React state
// around these two functions, which is where the behavior worth pinning lives.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  filterMultiSelectOptions,
  multiSelectSummary,
  type MultiSelectOption,
} from "../components/ui/multi-select";

const OPTIONS: MultiSelectOption[] = [
  { value: "2026-W42", label: "Semana del 12 al 18 de octubre de 2026", secondary: "2026-W42" },
  { value: "2026-W43", label: "Semana del 19 al 25 de octubre de 2026", secondary: "2026-W43" },
  { value: "2026-W44", label: "Semana del 26 de octubre al 1 de noviembre de 2026" },
];

describe("filterMultiSelectOptions", () => {
  it("returns every option for a blank or whitespace term", () => {
    expect(filterMultiSelectOptions(OPTIONS, "")).toEqual(OPTIONS);
    expect(filterMultiSelectOptions(OPTIONS, "   ")).toEqual(OPTIONS);
  });

  it("matches the human label case-insensitively", () => {
    expect(filterMultiSelectOptions(OPTIONS, "19 AL 25")).toEqual([OPTIONS[1]]);
    expect(filterMultiSelectOptions(OPTIONS, "noviembre")).toEqual([OPTIONS[2]]);
  });

  it("matches the raw period key, so typing W43 finds the week", () => {
    expect(filterMultiSelectOptions(OPTIONS, "w43")).toEqual([OPTIONS[1]]);
    // An option without a secondary key is reachable by its label only.
    expect(filterMultiSelectOptions(OPTIONS, "2026-w44")).toEqual([]);
    expect(filterMultiSelectOptions(OPTIONS, "1 de noviembre")).toEqual([OPTIONS[2]]);
  });

  it("returns no options when nothing matches", () => {
    expect(filterMultiSelectOptions(OPTIONS, "zzz")).toEqual([]);
  });
});

describe("multiSelectSummary", () => {
  const values = (v: string[]) => v;

  it("shows the empty label when nothing is selected", () => {
    expect(multiSelectSummary(OPTIONS, values([]), "Todas las semanas", "semana")).toBe(
      "Todas las semanas",
    );
  });

  it("shows the option label when exactly one is selected", () => {
    expect(multiSelectSummary(OPTIONS, values(["2026-W43"]), "Todas las semanas", "semana")).toBe(
      OPTIONS[1].label,
    );
  });

  it("falls back to the raw value for a stale selection not in the options", () => {
    expect(multiSelectSummary(OPTIONS, values(["2025-W01"]), "Todas las semanas", "semana")).toBe(
      "2025-W01",
    );
  });

  it("counts several selections with the caller's noun", () => {
    expect(
      multiSelectSummary(OPTIONS, values(["2026-W42", "2026-W43", "2026-W44"]), "Todas las semanas", "semana"),
    ).toBe("3 semanas seleccionadas");
  });
});
