import { describe, expect, it } from "vitest";

import {
  addAmounts,
  compareAmounts,
  formatAmount,
  isZeroAmount,
  MoneyError,
  parseAmount,
} from "../lib/money";

/**
 * Exact money maths, no database (§13.10, A14). The whole point of the module
 * is that no float ever touches an amount: these tests pin the boundary cases
 * that a naive `Number` implementation gets wrong (10.05 + 0.10 → 10.15).
 */

describe("parseAmount / formatAmount round-trip", () => {
  it("parses DECIMAL strings into scaled cents exactly", () => {
    expect(parseAmount("10.05")).toBe(1005n);
    expect(parseAmount("0.10")).toBe(10n);
    expect(parseAmount("10")).toBe(1000n);
    expect(parseAmount("10.1")).toBe(1010n);
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("-2.50")).toBe(-250n);
    expect(parseAmount(" 7.77 ")).toBe(777n);
    expect(parseAmount(10.05)).toBe(1005n);
    expect(parseAmount(10n)).toBe(1000n);
  });

  it("formats cents back to NUMERIC(14,2) strings", () => {
    expect(formatAmount(1005n)).toBe("10.05");
    expect(formatAmount(10n)).toBe("0.10");
    expect(formatAmount(1000n)).toBe("10.00");
    expect(formatAmount(0n)).toBe("0.00");
    expect(formatAmount(-250n)).toBe("-2.50");
  });

  it("A14: 10.05 + 0.10 is exactly 10.15", () => {
    const total = addAmounts(parseAmount("10.05"), parseAmount("0.10"));
    expect(total).toBe(1015n);
    expect(formatAmount(total)).toBe("10.15");
    // Float pitfalls this module exists to avoid: unit conversion loses cents
    // and 0.1 + 0.2 is famously not 0.3 in IEEE-754.
    expect(0.29 * 100).not.toBe(29);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("accumulates many amounts without drift", () => {
    const many = Array.from({ length: 100 }, () => parseAmount("0.07"));
    expect(formatAmount(addAmounts(...many))).toBe("7.00");
  });
});

describe("parseAmount rejects garbage instead of guessing", () => {
  it("refuses more than 2 decimals, exponents and float debris", () => {
    expect(() => parseAmount("10.055")).toThrow(MoneyError);
    expect(() => parseAmount("1e3")).toThrow(MoneyError);
    expect(() => parseAmount("0.30000000000000004")).toThrow(MoneyError);
    expect(() => parseAmount("1,50")).toThrow(MoneyError);
    expect(() => parseAmount(".5")).toThrow(MoneyError);
    expect(() => parseAmount("10.")).toThrow(MoneyError);
    expect(() => parseAmount("")).toThrow(MoneyError);
    expect(() => parseAmount("abc")).toThrow(MoneyError);
    expect(() => parseAmount(NaN)).toThrow(MoneyError);
    expect(() => parseAmount(Infinity)).toThrow(MoneyError);
    expect(() => parseAmount(null)).toThrow(MoneyError);
    expect(() => parseAmount({ amount: 10 })).toThrow(MoneyError);
  });

  it("refuses amounts NUMERIC(14,2) cannot store (>12 integer digits)", () => {
    expect(() => parseAmount("123456789012.34")).not.toThrow();
    expect(() => parseAmount("1234567890123.45")).toThrow(MoneyError);
  });
});

describe("amount comparisons", () => {
  it("compares and detects zero without Number coercion", () => {
    expect(compareAmounts(parseAmount("10.00"), parseAmount("10"))).toBe(0);
    expect(compareAmounts(parseAmount("9.99"), parseAmount("10"))).toBe(-1);
    expect(compareAmounts(parseAmount("10.01"), parseAmount("10"))).toBe(1);
    expect(isZeroAmount(parseAmount("0.00"))).toBe(true);
    expect(isZeroAmount(parseAmount("0.01"))).toBe(false);
  });
});
