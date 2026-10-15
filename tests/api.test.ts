// =============================================================================
// tests/api.test.ts — the route-handler helpers in isolation.
//
// `next/headers` is mocked BEFORE the import so the suite stays a plain Node
// test: lib/api.ts pulls lib/auth/require.ts (server-only) for getSession, and
// this file never exercises the session path — requireApiSession has its own
// behavior covered where a request context exists.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { assertSameOrigin, clientIp, okResponse, parseJsonBody, parseQuery } from "@/lib/api";
import { ForbiddenError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://red.example/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("okResponse", () => {
  it("wraps data in the §10 success envelope", async () => {
    const response = okResponse({ hello: "mundo" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { hello: "mundo" } });
  });

  it("honors an explicit status (201 for creations)", () => {
    expect(okResponse({}, { status: 201 }).status).toBe(201);
  });
});

describe("parseJsonBody", () => {
  it("returns the schema output for a valid body", async () => {
    const schema = z.object({ name: z.string().trim().min(1) });
    await expect(parseJsonBody(jsonRequest('{"name":"  Ana "}'), schema)).resolves.toEqual({
      name: "Ana",
    });
  });

  it("names the real problem when the body is not JSON", async () => {
    const schema = z.object({});
    const promise = parseJsonBody(jsonRequest("no soy json"), schema);
    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    await expect(promise).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
      message: "El cuerpo de la solicitud no es JSON válido.",
    });
  });

  it("reports per-field messages for a schema mismatch", async () => {
    const schema = z.object({ age: z.coerce.number().min(1, "La edad debe ser positiva") });
    try {
      await parseJsonBody(jsonRequest('{"age":0}'), schema);
      expect.unreachable("parseJsonBody should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ age: "La edad debe ser positiva" });
    }
  });
});

describe("parseQuery", () => {
  it("collapses a repeated key to its first value", () => {
    const request = new Request("https://red.example/api/x?q=ana&q=beto");
    const parsed = parseQuery(request, z.object({ q: z.string() }));
    expect(parsed.q).toBe("ana");
  });

  it("coerces numbers per the schema", () => {
    const request = new Request("https://red.example/api/x?limit=25");
    const parsed = parseQuery(request, z.object({ limit: z.coerce.number().int().optional() }));
    expect(parsed.limit).toBe(25);
  });

  it("throws a 400 with field details for invalid parameters", () => {
    const request = new Request("https://red.example/api/x?limit=abc");
    try {
      parseQuery(request, z.object({ limit: z.coerce.number().int().min(1).optional() }));
      expect.unreachable("parseQuery should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as Record<string, string>;
      expect(Object.keys(details)).toEqual(["limit"]);
    }
  });
});

describe("assertSameOrigin", () => {
  it("allows a request with no Origin (curl, health checks, same-origin GETs)", () => {
    const request = new Request("https://red.example/api/x");
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("allows an Origin that matches Host", () => {
    const request = jsonRequest("{}", { origin: "https://red.example", host: "red.example" });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it("refuses an Origin that disagrees with Host", () => {
    const request = jsonRequest("{}", { origin: "https://evil.example", host: "red.example" });
    expect(() => assertSameOrigin(request)).toThrow(ForbiddenError);
  });

  it("refuses a request with no Host at all", () => {
    const request = new Request("https://red.example/api/x", {
      method: "POST",
      headers: { origin: "https://red.example" },
    });
    // fetch() derives Host from the URL; deleting it forces the missing-header case.
    request.headers.delete("host");
    expect(() => assertSameOrigin(request)).toThrow(ForbiddenError);
  });

  it("refuses an unparsable Origin", () => {
    const request = jsonRequest("{}", { origin: "not a url", host: "red.example" });
    expect(() => assertSameOrigin(request)).toThrow(ForbiddenError);
  });
});

describe("clientIp", () => {
  it("takes the first hop of X-Forwarded-For", () => {
    const request = jsonRequest("{}", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP", () => {
    const request = jsonRequest("{}", { "x-real-ip": "198.51.100.9" });
    expect(clientIp(request)).toBe("198.51.100.9");
  });

  it("returns null when neither header is present", () => {
    expect(clientIp(jsonRequest("{}"))).toBeNull();
  });
});
