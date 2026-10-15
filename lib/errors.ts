// =============================================================================
// lib/errors.ts — the single response shape of §10 and the error hierarchy.
//
//   "Todas las respuestas: { ok: true, data } o
//    { ok: false, error: { code, message, details? } }"
//
// One module owns it so a route handler cannot answer with a bare object on one
// day and a `throw new Error()` on the next: every failure in this codebase is
// an `AppError` (or becomes one in `toErrorResponse`), and every success goes
// through `ok()`.
//
// The `message` of an error is USER-FACING and is rendered verbatim, so it must
// never carry a stack, a SQL fragment or a setting key that a caller can use as
// an oracle. `details` is for the field-level validation map and nothing else.
//
// `ForbiddenError` (lib/authz.ts) extends `AppError`, so the 403 that
// `assertCanViewUser` throws needs no special case here.
// =============================================================================

/** §10 error body. `details` is optional and only carries structured context. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** §10 success envelope. */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

/** §10 failure envelope. */
export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  /** True when `total` was capped for performance; the UI says so. */
  truncated?: boolean;
}

/** Base class for every failure that maps to a deliberate HTTP status. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 400 — the request did not match the Zod schema for the endpoint. */
export class ValidationError extends AppError {
  constructor(message = "Los datos enviados no son válidos.", details?: unknown) {
    super(400, "VALIDATION_FAILED", message, details);
    this.name = "ValidationError";
  }
}

/** 401 — no session, or an unusable one. */
export class UnauthorizedError extends AppError {
  constructor(message = "Debes iniciar sesión para continuar.") {
    super(401, "UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

/** 404 — the addressed resource does not exist, or is soft-deleted. */
export class NotFoundError extends AppError {
  constructor(message = "No se encontró la información solicitada.") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

/** Success envelope. */
export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

/** Failure envelope. */
export function fail(error: ApiErrorBody): ApiFailure {
  return { ok: false, error };
}

/** Field-keyed Zod issues, flattened to the first message per field. */
export function fieldErrorsFrom(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    if (out[key] === undefined) out[key] = issue.message;
  }
  return out;
}

/**
 * Map any thrown value to the §10 failure envelope.
 *
 * An unknown error becomes a generic 500 whose message says nothing about the
 * internals: a Prisma or `pg` message can carry a table name, a constraint or a
 * fragment of user input, and §13.9 forbids PII in what leaks out. The real
 * error is logged server-side where an operator can see it.
 */
export function toErrorResponse(error: unknown, log: (line: string) => void = console.error): Response {
  if (error instanceof AppError) {
    return Response.json(fail({ code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }), {
      status: error.status,
    });
  }

  log(`[api] unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return Response.json(
    fail({ code: "INTERNAL_ERROR", message: "Ocurrió un error inesperado. Intenta de nuevo." }),
    { status: 500 },
  );
}
