// =============================================================================
// tests/confirm-dialog.test.ts — the pure rule behind the rejection flow
// (components/ui/confirm-dialog.tsx): a motive made only of whitespace is not
// a motive, and the inline copy must match what the server enforces.
//
// No DOM: focus trapping and focus restore are integration behavior; the
// validation decision is the piece worth pinning without a renderer.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  isRejectionMotiveValid,
  REJECTION_MOTIVE_ERROR,
} from "../components/ui/confirm-dialog";

describe("isRejectionMotiveValid", () => {
  it("refuses an empty motive", () => {
    expect(isRejectionMotiveValid("")).toBe(false);
  });

  it("refuses whitespace, tabs and newlines", () => {
    expect(isRejectionMotiveValid("   ")).toBe(false);
    expect(isRejectionMotiveValid("\t\n ")).toBe(false);
  });

  it("accepts a real motive", () => {
    expect(isRejectionMotiveValid("El comprobante no coincide.")).toBe(true);
    expect(isRejectionMotiveValid("  Adjuntaste otra semana.  ")).toBe(true);
  });

  it("keeps the copy the server-side guard implies", () => {
    expect(REJECTION_MOTIVE_ERROR).toBe("El rechazo necesita un motivo.");
  });
});
