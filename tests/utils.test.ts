// =============================================================================
// tests/utils.test.ts — lib/utils.ts (`cn`), WU4 coverage.
//
// One-liner class merger used by every component: clsx handles conditionals
// and arrays, tailwind-merge resolves conflicting utilities so the LAST one
// wins. Both behaviors are pinned here because a regression would silently
// change component styling.
// =============================================================================

import { describe, expect, it } from "vitest";

import { cn } from "../lib/utils";

describe("cn", () => {
  it("joins plain class names", () => {
    expect(cn("flex", "items-center")).toBe("flex items-center");
  });

  it("drops falsy conditionals (clsx behavior)", () => {
    expect(cn("base", false && "off", undefined, null, "")).toBe("base");
  });

  it("resolves conflicting Tailwind utilities, last one wins", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("supports arrays and conditional objects (clsx behavior)", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });

  it("returns an empty string with no inputs", () => {
    expect(cn()).toBe("");
  });
});
