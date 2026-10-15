// =============================================================================
// lib/api.ts — the thin skin every route handler shares (§10).
//
// Route handlers do FOUR things and delegate everything else:
//   1. parse (Zod, here)            2. authenticate (requireApiSession)
//   3. authorize + act (the libs)   4. serialize (okResponse / withApi)
//
// WHY `UnauthorizedError` AND NOT A REDIRECT
// ------------------------------------------
// lib/auth/require.ts redirects because it serves React Server Components,
// where a redirect is the correct UX. An API route that answered a fetch()
// with a 307 to /login would hand the caller HTML pretending to be JSON.
// `requireApiSession` therefore throws the 401 envelope instead.
//
// CSRF FOR MUTATIONS
// ------------------
// Next verifies the Origin of Server Actions but not of route handlers. The
// public register endpoint has no cookie to forge, so it only needs a light
// same-origin check (`assertSameOrigin`) — and the authenticated mutations of
// the portal are Server Actions precisely to inherit Next's own check, the
// same reasoning as lib/auth/actions.ts.
// =============================================================================

import type { ZodType } from "zod";

import { ForbiddenError } from "./authz";
import { UnauthorizedError, ValidationError, fieldErrorsFrom, ok, toErrorResponse } from "./errors";
import { getSession } from "./auth/require";
import type { SessionPayload } from "./auth/session";

/** Run a handler and map every failure to the §10 failure envelope. */
export async function withApi(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** `{ ok: true, data }`, status 200 unless told otherwise. */
export function okResponse<T>(data: T, init?: ResponseInit): Response {
  return Response.json(ok(data), init);
}

/** An authenticated session, or `UnauthorizedError` (401 envelope). */
export async function requireApiSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/** Parse a JSON body against a Zod schema, or throw a 400 with field errors. */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // An empty or malformed body is a client error, not a server fault: the
    // schema's own messages would never render, so name the real problem.
    throw new ValidationError("El cuerpo de la solicitud no es JSON válido.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Revisa los datos enviados.", fieldErrorsFrom(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Parse query-string parameters against a Zod schema (with coercion).
 * Array params collapse to their FIRST value: the endpoints here are not
 * batch APIs, and a repeated key is far more likely to be a bug than a wish.
 */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (raw[key] === undefined) raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Parámetros inválidos.", fieldErrorsFrom(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Reject a browser request whose Origin disagrees with Host.
 *
 * A missing Origin is allowed: same-origin GETs, curl and the deployment's own
 * health checks do not send one, and this check exists to stop a third-party
 * page from POSTing on a user's behalf — not to authenticate anyone.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const host = request.headers.get("host");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ForbiddenError("invalid Origin header");
  }
  if (!host || parsed.host !== host) {
    throw new ForbiddenError("cross-origin request refused");
  }
}

/**
 * Best-effort client address for throttling.
 *
 * Behind the deployment's reverse proxy the socket address is the proxy, so
 * `x-forwarded-for` (first hop) is the only usable signal. It is spoofable by
 * direct clients — acceptable here because the throttle's job is to blunt
 * scripted abuse, not to be an authentication factor.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip");
}
