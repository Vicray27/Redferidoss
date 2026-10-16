import { describe, expect, it } from "vitest";

import { maskSensitive } from "../lib/mask";

/**
 * §13.8 masking helper. The exact shape is policy ("V-1234****"), so it is
 * pinned here; the CONSUMPTION (who gets the masked value) is pinned in
 * tests/network.test.ts.
 */

describe("maskSensitive", () => {
  it("keeps the first 6 characters and masks the rest", () => {
    expect(maskSensitive("V-12345678")).toBe("V-1234****");
    expect(maskSensitive("+595 981 123 456")).toBe("+595 9****");
  });

  it("masks more of short values, never less", () => {
    expect(maskSensitive("123")).toBe("****");
    expect(maskSensitive("1234")).toBe("1****");
    expect(maskSensitive("123456")).toBe("1****");
  });

  it("passes absence through instead of inventing a value", () => {
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive(undefined)).toBeNull();
  });
});
