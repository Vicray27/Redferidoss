// =============================================================================
// POST /api/cron/{job} — scheduled-job entry point (§9).
//
// Contract:
//   1. the shared secret is checked FIRST, so an unauthenticated caller cannot
//      even enumerate which jobs exist;
//   2. an unset CRON_SECRET is a 503, never an open door — an endpoint that
//      fails open because a variable is missing is a public job trigger;
//   3. a registered job with `implemented: true` runs and answers its summary
//      in the §10 envelope; a registered but unimplemented one answers 501 —
//      the honest answer for any future registry-first job (all six §9 jobs
//      are implemented since F7, D59–D62).
//
// `executeJob` receives the process-wide client and settings reader; the job
// bodies are dependency-injected (jobs/execute.ts) and idempotent by
// construction (D41), so this route stays a thin, authenticated dispatcher.
// =============================================================================

import { NextResponse } from "next/server";

import { findJob } from "@/jobs";
import { executeJob } from "@/jobs/execute";
import { okResponse } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toErrorResponse } from "@/lib/errors";
import { settings } from "@/lib/settings";

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
): Promise<Response> {
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

  if (!job.implemented) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NOT_IMPLEMENTED",
          message: `Job "${job.name}" is not implemented in this build.`,
        },
        data: { job: job.name, schedule: job.schedule, implemented: job.implemented },
      },
      { status: 501 },
    );
  }

  try {
    const summary = await executeJob(job.name, { db: prisma, settings, now: new Date() });
    return okResponse({ job: job.name, schedule: job.schedule, summary });
  } catch (error) {
    // A failing job answers the §10 failure envelope with nothing internal
    // in it; the real error is logged server-side by toErrorResponse.
    return toErrorResponse(error);
  }
}