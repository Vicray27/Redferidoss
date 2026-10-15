import { describe, expect, it, vi } from "vitest";

import {
  AppError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  fail,
  fieldErrorsFrom,
  ok,
  toErrorResponse,
} from "../lib/errors";

/**
 * §10 pins one response shape for every endpoint:
 *   { ok: true, data } | { ok: false, error: { code, message, details? } }
 *
 * These tests pin the CONVERSION, which is where the shape actually breaks:
 * a handler that throws must come out as the failure envelope with the right
 * HTTP status, and an unexpected error must not leak a stack, a table name or
 * a fragment of the request into the response body.
 */

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("ok / fail — the two envelopes of §10", () => {
  it("ok() wraps data exactly once", () => {
    expect(ok({ id: "1" })).toEqual({ ok: true, data: { id: "1" } });
  });

  it("fail() wraps the error body", () => {
    expect(fail({ code: "X", message: "m" })).toEqual({
      ok: false,
      error: { code: "X", message: "m" },
    });
  });
});

describe("toErrorResponse — AppError subclasses map to their HTTP status", () => {
  it("ValidationError -> 400 with the details map", async () => {
    const response = toErrorResponse(new ValidationError("No válido.", { email: "Requerido" }));

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "No válido.", details: { email: "Requerido" } },
    });
  });

  it("UnauthorizedError -> 401", async () => {
    const response = toErrorResponse(new UnauthorizedError());

    expect(response.status).toBe(401);
    expect((await body(response)) as { error: { code: string } }).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("NotFoundError -> 404", async () => {
    const response = toErrorResponse(new NotFoundError());

    expect(response.status).toBe(404);
  });

  it("omits details when the error carries none", async () => {
    const response = toErrorResponse(new UnauthorizedError());

    const parsed = (await body(response)) as { error: Record<string, unknown> };
    expect("details" in parsed.error).toBe(false);
  });
});

describe("toErrorResponse — unknown errors fail closed", () => {
  it("a raw Error becomes a generic 500 without its message", async () => {
    const log = vi.fn();
    const response = toErrorResponse(
      new Error('relation "users" does not exist at character 42'),
      log,
    );

    expect(response.status).toBe(500);
    const parsed = (await body(response)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("INTERNAL_ERROR");
    expect(parsed.error.message).not.toContain("users");
    // The operator still sees the real cause, server-side only.
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("users");
  });

  it("a non-Error throw is still a 500 and does not echo the value", async () => {
    const log = vi.fn();
    const response = toErrorResponse({ secret: "token" }, log);

    expect(response.status).toBe(500);
    const parsed = (await body(response)) as { error: { message: string } };
    expect(parsed.error.message).not.toContain("secret");
  });
});

describe("fieldErrorsFrom — first message per field", () => {
  it("keeps the first issue of each path and ignores unrelated entries", () => {
    const result = fieldErrorsFrom([
      { path: ["email"], message: "Requerido" },
      { path: ["email"], message: "Formato inválido" },
      { path: ["password"], message: "Muy corta" },
      { path: [], message: "Global" },
    ]);

    expect(result).toEqual({ email: "Requerido", password: "Muy corta", _: "Global" });
  });
});

describe("AppError contract", () => {
  it("carries status, code and message", () => {
    const error = new AppError(418, "TEAPOT", "Soy una tetera");

    expect(error.status).toBe(418);
    expect(error.code).toBe("TEAPOT");
    expect(error.message).toBe("Soy una tetera");
    expect(error).toBeInstanceOf(Error);
  });
});
