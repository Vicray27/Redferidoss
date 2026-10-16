// =============================================================================
// lib/security-headers.ts — the §13 security response headers, built in ONE
// place so `middleware.ts` only decides WHEN to attach them, not WHAT they say.
//
// The CSP is nonce-based (Next.js "Content Security Policy" recipe): the
// middleware generates a nonce, puts it on the REQUEST headers together with
// the policy, and Next.js automatically stamps that nonce onto its own
// scripts and styles when it renders the page. This is the only shape that
// lets `script-src` drop `unsafe-inline`/`unsafe-eval` in production, which is
// the point of §13 for a portal that holds PII.
//
// Production `style-src` keeps `'unsafe-inline'` and deliberately does NOT
// carry the nonce: components with dynamic geometry (charts, the network
// tree) pass `style={{...}}` attributes, and per CSP3 the presence of a
// nonce/hash source makes browsers IGNORE `'unsafe-inline'`, which would
// break those attributes. Styles are not an XSS sink here (scripts are
// locked down), so the trade is: strict scripts, pragmatic styles.
//
// Dev relaxes `script-src` with `'unsafe-eval'`/`'unsafe-inline'` because the
// dev bundler and HMR need them; the nonce is omitted there so browsers do
// not discard `'unsafe-inline'`. This module stays Edge-safe (Web Crypto +
// btoa only).
// =============================================================================

/** Header carrying the nonce to the render pass (Next.js reads exactly this). */
export const NONCE_HEADER = "x-nonce";

/** CSP header name, shared by the request and the response. */
export const CSP_HEADER = "Content-Security-Policy";

/** §13 — a year, with subdomains, no preload commitment. */
export const HSTS_HEADER = "Strict-Transport-Security";

export interface SecurityHeaderOptions {
  /** `NODE_ENV === "production"`: the only mode allowed to tighten scripts. */
  isProduction: boolean;
}

/**
 * Unpredictable per-request nonce, base64 of 16 random bytes (128 bits).
 * `btoa` + Web Crypto keep this working in the Edge runtime and in Vitest
 * without a `node:buffer` import.
 */
export function createNonce(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The policy string. Exported for tests and for callers that need to assert
 * on directives; `securityHeadersFor` is what middleware should use.
 */
export function buildContentSecurityPolicy(nonce: string, isProduction: boolean): string {
  const scriptSrc = isProduction
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'unsafe-inline' 'unsafe-eval'`;

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // No nonce here — see the file header: the nonce would disable
    // 'unsafe-inline' and React style attributes would stop applying.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Modern replacement for X-Frame-Options; both go out for old agents.
    "frame-ancestors 'none'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ];

  return directives.join("; ");
}

/**
 * Every response header this phase adds, keyed exactly as they go on the
 * wire. The middleware applies them to every response it lets through, every
 * redirect it issues and every short-circuit it returns.
 */
export function securityHeadersFor(
  nonce: string,
  options: SecurityHeaderOptions,
): Record<string, string> {
  return {
    [CSP_HEADER]: buildContentSecurityPolicy(nonce, options.isProduction),
    [HSTS_HEADER]: "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}
