// =============================================================================
// tests/throttle.test.ts — fixed-window throttle units (§13.3).
//
// The clock is injected in every test: asserting on wall-clock behavior would
// make a flaky, slow suite out of three integers.
// =============================================================================

import { describe, expect, it } from "vitest";

import { toErrorResponse } from "@/lib/errors";
import { RateLimitedError, TOO_MANY_REQUESTS_MESSAGE, createThrottle } from "@/lib/throttle";

function ticket() {
  const clock = { now: 1_700_000_000_000 };
  return { clock, throttle: createThrottle({ windowMs: 1000, max: 2, now: () => clock.now }) };
}

describe("createThrottle — window arithmetic", () => {
  it("allows exactly `max` attempts per key, then refuses", () => {
    const { throttle } = ticket();

    expect(throttle.attempt("ip-1").allowed).toBe(true);
    expect(throttle.attempt("ip-1").allowed).toBe(true);

    const third = throttle.attempt("ip-1");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("reports retryAfterMs as the distance to the end of the window", () => {
    const { clock, throttle } = ticket();

    const first = throttle.attempt("ip-1");
    clock.now += 400;
    const second = throttle.attempt("ip-1");

    // Window started at the earlier second boundary; 1000 - 400 = 600 left.
    expect(first.retryAfterMs).toBe(1000);
    expect(second.retryAfterMs).toBe(600);
  });

  it("opens a fresh window once the clock crosses the boundary", () => {
    const { clock, throttle } = ticket();

    throttle.attempt("ip-1");
    throttle.attempt("ip-1");
    expect(throttle.attempt("ip-1").allowed).toBe(false);

    clock.now += 1000;
    expect(throttle.attempt("ip-1").allowed).toBe(true);
  });

  it("keeps keys independent", () => {
    const { throttle } = ticket();

    throttle.attempt("ip-1");
    throttle.attempt("ip-1");

    expect(throttle.attempt("ip-2").allowed).toBe(true);
    expect(throttle.attempt("ip-1").allowed).toBe(false);
  });

  it("drops stale keys once the map grows past maxKeys", () => {
    const clock = { now: 0 };
    const throttle = createThrottle({
      windowMs: 1000,
      max: 5,
      maxKeys: 2,
      now: () => clock.now,
    });

    throttle.attempt("a");
    throttle.attempt("b");
    clock.now = 5000;
    throttle.attempt("c");
    // Adding "d" is what triggers the prune: the two keys from the previous
    // window go, the current one stays, "d" joins it.
    throttle.attempt("d");

    expect(throttle.size()).toBe(2);

    // The pruned key starts over in the CURRENT window, not the old one.
    const revived = throttle.attempt("a");
    expect(revived.allowed).toBe(true);
    expect(revived.retryAfterMs).toBe(1000);
  });

  it("rejects nonsense configuration loudly", () => {
    expect(() => createThrottle({ windowMs: 0, max: 1 })).toThrow(RangeError);
    expect(() => createThrottle({ windowMs: 1000, max: 0 })).toThrow(RangeError);
    expect(() => createThrottle({ windowMs: 1000, max: 1.5 })).toThrow(RangeError);
  });

  it("reset() empties the map", () => {
    const { throttle } = ticket();
    throttle.attempt("ip-1");
    throttle.reset();
    expect(throttle.size()).toBe(0);
  });
});

describe("RateLimitedError", () => {
  it("maps to the 429 envelope with the §10 shape", async () => {
    const response = toErrorResponse(new RateLimitedError());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: TOO_MANY_REQUESTS_MESSAGE },
    });
  });
});
