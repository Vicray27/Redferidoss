// =============================================================================
// tests/user-picker.test.ts — the pure rules of the payments person filter
// (app/admin/pagos/user-picker.tsx): the summary button copy and the checkbox
// toggle. No DOM and no testing-library: the React shell only renders these
// helpers.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  toggleUserSelection,
  userPickerSummary,
  type UserPickerOption,
} from "../app/admin/pagos/user-picker";

const ana: UserPickerOption = { id: "a", fullName: "Ana Pérez", publicCode: "REF-001" };
const beto: UserPickerOption = { id: "b", fullName: "Beto Gómez", publicCode: "REF-002" };
const carla: UserPickerOption = { id: "c", fullName: "Carla Ruiz", publicCode: "REF-003" };

describe("userPickerSummary", () => {
  it("states the empty label when nobody is selected", () => {
    expect(userPickerSummary([], "Todas las personas")).toBe("Todas las personas");
  });

  it("names the single selected person without opening the panel", () => {
    expect(userPickerSummary([ana], "Todas las personas")).toBe("Ana Pérez");
  });

  it("counts multiple selections", () => {
    expect(userPickerSummary([ana, beto], "Todas las personas")).toBe(
      "2 personas seleccionadas",
    );
  });
});

describe("toggleUserSelection", () => {
  it("appends a new person", () => {
    expect(toggleUserSelection([ana], beto).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("removes an already selected person", () => {
    expect(toggleUserSelection([ana, beto], ana).map((item) => item.id)).toEqual(["b"]);
  });

  it("does not mutate the previous list", () => {
    const current = [ana];
    toggleUserSelection(current, beto);
    toggleUserSelection(current, ana);
    expect(current.map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps one entry per id", () => {
    const toggled = toggleUserSelection([ana, beto], carla);
    expect(toggled.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(new Set(toggled.map((item) => item.id)).size).toBe(toggled.length);
  });
});
