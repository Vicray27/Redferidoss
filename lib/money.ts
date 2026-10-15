// =============================================================================
// lib/money.ts — exact money arithmetic in scaled integer cents (§5.5, §13.10).
//
// Every monetary value travels the system as a DECIMAL string ("10.05") and is
// persisted in NUMERIC(14,2). Inside this module the only representation is a
// BigInt count of cents: no float ever touches an amount. Parsing and formatting
// are the single conversion boundary, so 10.05 + 0.10 is exactly 10.15 (A14).
// =============================================================================

/** NUMERIC(14,2): up to 12 integer digits and up to 2 decimals. */
const AMOUNT_PATTERN = /^-?\d{1,12}(?:\.\d{1,2})?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Parses a DECIMAL amount ("10.05", 10.05, 10n) into scaled cents.
 * Floats already damaged by arithmetic (0.30000000000000004) are rejected
 * instead of silently rounded.
 */
export function parseAmount(raw: unknown): bigint {
  if (typeof raw === "bigint") return raw * 100n;

  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new MoneyError("El monto debe ser un número decimal finito.");
    }
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    throw new MoneyError("El monto debe ser un número decimal con hasta 2 decimales.");
  }

  if (!AMOUNT_PATTERN.test(text)) {
    throw new MoneyError("El monto debe ser un número decimal con hasta 2 decimales.");
  }

  const negative = text.startsWith("-");
  const [integer, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const cents = BigInt(integer) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -cents : cents;
}

/** Renders scaled cents back as the DECIMAL string NUMERIC(14,2) expects. */
export function formatAmount(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const integer = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}${integer}.${String(fraction).padStart(2, "0")}`;
}

export function addAmounts(...amounts: readonly bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

export function compareAmounts(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isZeroAmount(cents: bigint): boolean {
  return cents === 0n;
}
