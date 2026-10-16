import { describe, expect, it } from "vitest";

import {
  CSP_HEADER,
  HSTS_HEADER,
  NONCE_HEADER,
  buildContentSecurityPolicy,
  createNonce,
  securityHeadersFor,
} from "../lib/security-headers";

/**
 * §13 security headers, unit-level. The middleware applies these to every
 * response it processes (tests/auth-middleware.test.ts pins WHICH responses);
 * this file pins WHAT they say, because a directive typo silently weakens the
 * policy instead of failing anything.
 */

describe("createNonce", () => {
  it("returns a fresh base64 nonce per call", () => {
    const first = createNonce();
    const second = createNonce();

    expect(first).not.toBe(second);
    // 16 random bytes -> 24 base64 characters including padding.
    expect(first).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(first.length).toBe(24);
  });

  it("honours a requested byte length", () => {
    expect(createNonce(32).length).toBeGreaterThan(24);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("locks production scripts to the nonce, with no unsafe directive", () => {
    const csp = buildContentSecurityPolicy("NONCE123", true);
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"));

    expect(scriptSrc).toBe("script-src 'self' 'nonce-NONCE123' 'strict-dynamic'");
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("hardens the directives that are not about scripts", () => {
    const csp = buildContentSecurityPolicy("NONCE123", true);

    expect(csp.split("; ")).toEqual(
      expect.arrayContaining([
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ]),
    );
  });

  it("keeps style-src WITHOUT a nonce so React style attributes still apply", () => {
    // Per CSP3, a nonce/hash in style-src makes browsers ignore
    // 'unsafe-inline' — and the charts and the network tree pass style={{…}}
    // attributes. Styles are not the XSS sink here; scripts are locked down.
    const csp = buildContentSecurityPolicy("NONCE123", true);
    const styleSrc = csp.split("; ").find((directive) => directive.startsWith("style-src"));

    expect(styleSrc).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("relaxes scripts only in development, and ships no nonce there", () => {
    const csp = buildContentSecurityPolicy("NONCE123", false);
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src"));

    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
    // A nonce in dev would make browsers ignore 'unsafe-inline' and break HMR.
    expect(scriptSrc).not.toContain("NONCE123");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});

describe("securityHeadersFor", () => {
  it("carries CSP, HSTS, nosniff, frame and referrer policy", () => {
    const headers = securityHeadersFor("N1", { isProduction: true });

    expect(headers[CSP_HEADER]).toContain("nonce-N1");
    expect(headers[HSTS_HEADER]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the request-side header names the Next.js recipe expects", () => {
    // Next.js reads exactly these two from the REQUEST headers to stamp the
    // nonce onto the scripts and styles it renders.
    expect(NONCE_HEADER).toBe("x-nonce");
    expect(CSP_HEADER).toBe("Content-Security-Policy");
  });
});
