import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/cron/[job]/route";

/**
 * The cron endpoint is a security boundary, and it is the one route in F1
 * that must be provable without a database: everything it does before 501 is
 * authentication and lookup. §9 names `x-cron-secret`; `Authorization: Bearer`
 * is the canonical form (D13). An unset CRON_SECRET must disable the endpoint
 * rather than open it.
 */

const SECRET = "s3cr3t-cron-token-for-tests";

function call(job: string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`https://example.test/api/cron/${encodeURIComponent(job)}`, { method: "POST", headers }),
    { params: Promise.resolve({ job }) },
  );
}

const authorized = { authorization: `Bearer ${SECRET}` };

describe("POST /api/cron/{job} — authentication", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });

  it("rejects a request with no credentials", async () => {
    const response = await call("cycle:ensure");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong bearer token", async () => {
    const response = await call("cycle:ensure", { authorization: "Bearer wrong" });
    expect(response.status).toBe(401);
  });

  it("rejects a bearer prefix with an empty token", async () => {
    const response = await call("cycle:ensure", { authorization: "Bearer " });
    expect(response.status).toBe(401);
  });

  it("rejects a token of the right length but wrong content (no prefix oracle)", async () => {
    const response = await call("cycle:ensure", { authorization: `Bearer ${"x".repeat(SECRET.length)}` });
    expect(response.status).toBe(401);
  });

  it("accepts the spec's x-cron-secret header as well", async () => {
    const response = await call("cycle:ensure", { "x-cron-secret": SECRET });
    expect(response.status).toBe(501);
  });

  it("prefers Authorization over x-cron-secret when both are present", async () => {
    const response = await call("cycle:ensure", {
      authorization: "Bearer wrong",
      "x-cron-secret": SECRET,
    });
    expect(response.status).toBe(401);
  });

  it("does not reveal whether a job exists to an unauthenticated caller", async () => {
    const unknown = await call("nope:not-a-job");
    const known = await call("cycle:ensure");
    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(await unknown.text()).toBe(await known.text());
  });
});

describe("POST /api/cron/{job} — dispatch", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("answers 501 for a registered but unimplemented job", async () => {
    const response = await call("cycle:ensure", authorized);
    expect(response.status).toBe(501);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    expect(body.data.job).toBe("cycle:ensure");
    expect(body.data.implemented).toBe(false);
  });

  it("answers 404 for a job that is not in the registry", async () => {
    const response = await call("nope:not-a-job", authorized);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("UNKNOWN_JOB");
  });

  it("is registered for every job the spec lists", async () => {
    const names = [
      "cycle:ensure",
      "cycle:obligations",
      "cycle:reminders",
      "cycle:close",
      "tree:verify",
      "files:gc",
    ];
    for (const name of names) {
      expect((await call(name, authorized)).status, name).toBe(501);
    }
  });
});

describe("POST /api/cron/{job} — misconfiguration", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("fails closed with 503 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await call("cycle:ensure", { authorization: "Bearer anything" });

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CRON_SECRET_MISSING");
  });
});