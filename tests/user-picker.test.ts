// =============================================================================
// tests/user-picker.test.ts — the pure rules of the payments person filter
// (app/admin/pagos/user-picker.tsx): the summary button copy, the checkbox
// toggle and the local directory filter. No DOM and no testing-library: the
// React shell only renders these helpers.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  filterUserOptions,
  toggleUserSelection,
  userPickerSummary,
  type UserPickerOption,
} from "../app/admin/pagos/user-picker";

const ana: UserPickerOption = {
  id: "a",
  fullName: "Ana Pérez",
  publicCode: "REF-001",
  email: "ana@example.org",
};
const beto: UserPickerOption = {
  id: "b",
  fullName: "Beto Gómez",
  publicCode: "REF-002",
  email: "beto@example.org",
};
const carla: UserPickerOption = {
  id: "c",
  fullName: "Carla Ruiz",
  publicCode: "REF-003",
  email: "carla@otro.org",
};

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

describe("filterUserOptions", () => {
  const all = [ana, beto, carla];

  it("returns a copy of the whole list for a blank term", () => {
    const filtered = filterUserOptions(all, "   ");
    expect(filtered.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(filtered).not.toBe(all);
  });

  it("matches the name case-insensitively and keeps the list order", () => {
    expect(filterUserOptions(all, "ANA").map((item) => item.id)).toEqual(["a"]);
  });

  it("matches the public code", () => {
    expect(filterUserOptions(all, "ref-002").map((item) => item.id)).toEqual(["b"]);
  });

  it("matches the email even though it is never displayed", () => {
    expect(filterUserOptions(all, "carla@").map((item) => item.id)).toEqual(["c"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterUserOptions(all, "zzz")).toEqual([]);
  });
});
