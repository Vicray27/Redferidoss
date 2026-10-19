// =============================================================================
// tests/toast.test.ts — the pure rules of the toast stack
// (components/ui/toast.tsx): insertion order, the four-toast cap and the
// documented auto-dismiss delays.
//
// No DOM and no testing-library: the React shell only schedules these helpers.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  pushToastStack,
  TOAST_MAX_VISIBLE,
  toastDurationMs,
  type ToastItem,
} from "../components/ui/toast";

function toast(id: number, variant: ToastItem["variant"] = "success"): ToastItem {
  return { id, variant, text: `toast ${id}` };
}

describe("pushToastStack", () => {
  it("appends the newest toast last, in insertion order", () => {
    const stack = pushToastStack([toast(1), toast(2)], toast(3));
    expect(stack.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("caps the stack at four and drops the oldest first", () => {
    const full = [toast(1), toast(2), toast(3), toast(4)];
    const stack = pushToastStack(full, toast(5));
    expect(TOAST_MAX_VISIBLE).toBe(4);
    expect(stack.map((item) => item.id)).toEqual([2, 3, 4, 5]);
  });

  it("honors a custom cap and keeps the newest entries", () => {
    const stack = pushToastStack([toast(1), toast(2), toast(3)], toast(4), 2);
    expect(stack.map((item) => item.id)).toEqual([3, 4]);
  });

  it("returns an empty stack when the cap is zero", () => {
    expect(pushToastStack([toast(1)], toast(2), 0)).toEqual([]);
  });

  it("does not mutate the previous stack", () => {
    const current = [toast(1)];
    pushToastStack(current, toast(2));
    expect(current.map((item) => item.id)).toEqual([1]);
  });
});

describe("toastDurationMs", () => {
  it("keeps success confirmations short and errors readable", () => {
    expect(toastDurationMs("success")).toBe(4000);
    expect(toastDurationMs("error")).toBe(8000);
  });
});
