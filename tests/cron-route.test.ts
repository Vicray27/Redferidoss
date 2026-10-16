import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/cron/[job]/route";
import { executeJob } from "@/jobs/execute";

/**
 * The cron endpoint is a security boundary: authentication and lookup happen
 * before any job runs, and an unset CRON_SECRET must disable it rather than
 * open it. F4a made the two cycle jobs executable and F7 adds the rest one at
 * a time, so the happy path is tested against a mocked runner — `executeJob`
 * is the seam; the SQL it emits is asserted in tests/cycle-jobs.test.ts —
 * while every job still waiting for its body must answer the honest 501.
 */

vi.mock("@/jobs/execute", () => ({ executeJob: vi.fn() }));

const mockExecute = vi.mocked(executeJob);

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
    // A still-stubbed job proves the header passed authentication without
    // asserting anything about dispatch: the 501 is the honest stage answer.
    const response = await call("cycle:close", { "x-cron-secret": SECRET });
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
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("answers 501 for a registered but unimplemented job", async () => {
    const response = await call("cycle:close", authorized);
    expect(response.status).toBe(501);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    expect(body.data.job).toBe("cycle:close");
    expect(body.data.implemented).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("answers 404 for a job that is not in the registry", async () => {
    const response = await call("nope:not-a-job", authorized);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("UNKNOWN_JOB");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("runs an implemented job and returns its summary in the §10 envelope", async () => {
    const summary = { planned: 5, created: 4, skipped: 1, raced: 0 };
    mockExecute.mockResolvedValueOnce(summary);

    const response = await call("cycle:ensure", authorized);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.job).toBe("cycle:ensure");
    expect(body.data.schedule).toBe("every hour");
    expect(body.data.summary).toEqual(summary);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      "cycle:ensure",
      expect.objectContaining({ now: expect.any(Date) }),
    );
  });

  it("maps a failing job to the §10 failure envelope without leaking it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExecute.mockRejectedValueOnce(
      new Error('relation "payment_cycles" does not exist at character 13'),
    );

    const response = await call("cycle:obligations", authorized);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("payment_cycles");
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("is registered for every job the spec lists, each at its own stage", async () => {
    const stubs = ["cycle:close", "tree:verify", "files:gc"];
    for (const name of stubs) {
      expect((await call(name, authorized)).status, name).toBe(501);
    }

    const implemented = ["cycle:ensure", "cycle:obligations", "cycle:reminders"];
    for (const name of implemented) {
      expect((await call(name, authorized)).status, name).toBe(200);
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
