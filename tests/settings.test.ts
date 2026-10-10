import { describe, expect, it } from "vitest";

import {
  createSettingsReader,
  SettingsMissingError,
  SETTINGS_CACHE_TTL_MS,
  type SettingsRow,
} from "../lib/settings";

/**
 * No database: the reader is built over a fake loader, which is exactly why
 * `createSettingsReader` takes the loader as a parameter. These tests pin the
 * spec scenarios "Cache and invalidation" and "Missing key throws" (§6).
 */

function fakeLoader(initial: Record<string, unknown>) {
  const values = new Map<string, unknown>(Object.entries(initial));
  let calls = 0;
  const loader = async (key: string): Promise<SettingsRow | null> => {
    calls += 1;
    if (!values.has(key)) return null;
    return { key, value: values.get(key), type: "INT" };
  };
  return {
    loader,
    values,
    get calls() {
      return calls;
    },
  };
}

describe("settings reader — missing key", () => {
  it("throws SettingsMissingError naming the key, with no default value", async () => {
    const { loader } = fakeLoader({});
    const reader = createSettingsReader(loader);

    await expect(reader.getOrThrow("referral.max_direct_referrals")).rejects.toThrow(
      SettingsMissingError,
    );
    await expect(reader.getOrThrow("referral.max_direct_referrals")).rejects.toThrow(
      /referral\.max_direct_referrals/,
    );
    // The message must point at the fix instead of inventing a fallback.
    await expect(reader.getOrThrow("referral.max_direct_referrals")).rejects.toThrow(
      /seed:root/,
    );
  });

  it("get() returns null instead of a silent default", async () => {
    const { loader } = fakeLoader({});
    const reader = createSettingsReader(loader);

    await expect(reader.get("payments.currency")).resolves.toBeNull();
  });

  it("exposes the offending key on the error object", async () => {
    const { loader } = fakeLoader({});
    const reader = createSettingsReader(loader);

    await expect(reader.getOrThrow("payments.grace_hours")).rejects.toMatchObject({
      name: "SettingsMissingError",
      key: "payments.grace_hours",
    });
  });

  it("does not negative-cache: a key inserted later is visible immediately", async () => {
    const store = fakeLoader({});
    const reader = createSettingsReader(store.loader);

    expect(await reader.get("payments.currency")).toBeNull();
    store.values.set("payments.currency", "EUR");
    expect(await reader.get("payments.currency")).toBe("EUR");
  });
});

describe("settings reader — cache", () => {
  it("serves a second read from cache without hitting the database", async () => {
    const store = fakeLoader({ "payments.currency": "USD" });
    const reader = createSettingsReader(store.loader);

    expect(await reader.get("payments.currency")).toBe("USD");
    expect(await reader.get("payments.currency")).toBe("USD");
    expect(store.calls).toBe(1);
    expect(reader.size()).toBe(1);
  });

  it("caches for exactly 60 seconds and re-reads afterwards", async () => {
    let clock = 1_000_000;
    const store = fakeLoader({ "payments.grace_hours": 48 });
    const reader = createSettingsReader(store.loader, { now: () => clock });

    expect(await reader.get("payments.grace_hours")).toBe(48);
    clock += SETTINGS_CACHE_TTL_MS - 1;
    expect(await reader.get("payments.grace_hours")).toBe(48);
    expect(store.calls).toBe(1);

    clock += 1; // exactly at the TTL boundary the entry is stale
    expect(await reader.get("payments.grace_hours")).toBe(48);
    expect(store.calls).toBe(2);
    expect(SETTINGS_CACHE_TTL_MS).toBe(60_000);
  });

  it("peek() reads the cache without touching the loader", async () => {
    const store = fakeLoader({ "general.timezone": "America/Caracas" });
    const reader = createSettingsReader(store.loader);

    expect(reader.peek("general.timezone")).toBeUndefined();
    await reader.get("general.timezone");
    expect(reader.peek("general.timezone")).toBe("America/Caracas");
    expect(store.calls).toBe(1);
  });

  it("caches each key independently", async () => {
    const store = fakeLoader({ a: 1, b: 2 });
    const reader = createSettingsReader(store.loader);

    await reader.get("a");
    await reader.get("b");
    await reader.get("a");
    expect(store.calls).toBe(2);
    expect(reader.size()).toBe(2);
  });
});

describe("settings reader — LISTEN/NOTIFY invalidation", () => {
  it("drops one key on invalidate(key) so the next get returns the new value", async () => {
    const store = fakeLoader({ "referral.max_direct_referrals": 12 });
    const reader = createSettingsReader(store.loader);

    // Acceptance A1: changing 12 -> 10 must take effect immediately.
    expect(await reader.getOrThrow<number>("referral.max_direct_referrals")).toBe(12);
    store.values.set("referral.max_direct_referrals", 10);
    expect(await reader.get("referral.max_direct_referrals")).toBe(12); // still cached

    reader.invalidate("referral.max_direct_referrals"); // what the NOTIFY handler calls
    expect(await reader.getOrThrow<number>("referral.max_direct_referrals")).toBe(10);
  });

  it("drops everything on invalidate() with no key", async () => {
    const store = fakeLoader({ a: 1, b: 2 });
    const reader = createSettingsReader(store.loader);

    await reader.get("a");
    await reader.get("b");
    expect(reader.size()).toBe(2);

    reader.invalidate();
    expect(reader.size()).toBe(0);
    await reader.get("a");
    expect(store.calls).toBe(3);
  });

  it("leaves other keys cached when one key is invalidated", async () => {
    const store = fakeLoader({ a: 1, b: 2 });
    const reader = createSettingsReader(store.loader);

    await reader.get("a");
    await reader.get("b");
    reader.invalidate("a");

    expect(reader.peek("a")).toBeUndefined();
    expect(reader.peek("b")).toBe(2);
  });

  it("keeps caches isolated between readers", async () => {
    const store = fakeLoader({ a: 1 });
    const first = createSettingsReader(store.loader);
    const second = createSettingsReader(store.loader);

    await first.get("a");
    expect(first.size()).toBe(1);
    expect(second.size()).toBe(0);
  });
});