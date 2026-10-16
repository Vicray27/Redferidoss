// =============================================================================
// lib/mask.ts — `visibility.mask_sensitive_fields` in practice (§13.8).
//
// When the setting is on, a viewer who sees SOMEONE ELSE's record gets the
// phone (and, if it ever surfaces, the national id) masked in the payload
// itself — not hidden by the UI. The API is the boundary that leaks or does
// not leak; a client that chose to ignore a CSS class would still hold the
// real value, so masking happens at serialization time (lib/network.ts).
//
// The shape keeps the first few characters ("V-1234****"): enough for a human
// to recognize the record they were told about, never enough to reconstruct
// it. Short values degrade to masking MORE, not less.
// =============================================================================

/**
 * Mask a sensitive display value. `null`/`undefined` pass through so optional
 * fields keep their "absent" meaning instead of becoming a fake string.
 */
export function maskSensitive(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();
  if (trimmed.length <= 3) return "****";
  if (trimmed.length <= 6) return `${trimmed[0]}****`;

  return `${trimmed.slice(0, 6)}****`;
}
