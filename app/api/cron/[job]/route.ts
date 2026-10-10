// =============================================================================
// POST /api/cron/{job} — scheduled-job entry point (§9).
//
// Contract, and nothing beyond it in F1:
//   1. the shared secret is checked FIRST, so an unauthenticated caller cannot
//      even enumerate which jobs exist;
//   2. an unset CRON_SECRET is a 503, never an open door — an endpoint that
//      fails open because a variable is missing is a public job trigger;
//   3. a registered but unimplemented job answers 501, which is the honest
//      answer: pg_cron scheduling and the job bodies land in F7 (D1).
//
// Real jobs will run under `pg_try_advisory_lock` (§9 idempotency) regardless
// of whether the scheduler ends up being pg_cron or the node-cron fallback.
// =============================================================================

import { NextResponse } from "next/server";

import { findJob } from "@/jobs";

/** Comparison is constant-time so the endpoint cannot be used as an oracle. */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * `Authorization: Bearer <CRON_SECRET>` is canonical; `x-cron-secret` is
 * accepted because §9 names that header literally and pg_cron/node-cron
 * configuration in F7 may use either (D13).
 */
function extractSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-cron-secret");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CRON_SECRET_MISSING",
          message: "CRON_SECRET is not configured on the server; the cron endpoint stays disabled.",
        },
      },
      { status: 503 },
    );
  }

  const provided = extractSecret(request);
  if (!provided || !secretsMatch(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid cron secret." } },
      { status: 401 },
    );
  }

  const { job: jobName } = await params;
  const job = findJob(jobName);

  if (!job) {
    return NextResponse.json(
      { ok: false, error: { code: "UNKNOWN_JOB", message: `No such job: ${jobName}` } },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: `Job "${job.name}" is not implemented yet. Scheduled jobs land in F7.`,
      },
      data: { job: job.name, schedule: job.schedule, implemented: job.implemented },
    },
    { status: 501 },
  );
}