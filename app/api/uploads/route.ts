// =============================================================================
// POST /api/uploads — the §10.4 upload endpoint, local-disk flavour (D42).
//
// §10.4 names POST /api/uploads/sign (pre-signed URL). This deployment has no
// object store (MinIO's container is disabled in docker-compose), so F4a
// accepts the bytes directly: multipart/form-data, field "file", ≤ 10 MB,
// JPG/PNG/WEBP/PDF by magic bytes. That is a STRONGER contract than a signed
// PUT, where the object lands before anyone has looked at it — here the server
// sniffs the content itself, and an invalid file never reaches storage.
//
// The client flow (D29: mutations are Server Actions) is two steps: upload the
// file here, then submit the report/payment action with the returned fileId.
//
// Throttled per user (lib/throttle.ts): a 10 MB multipart body is the cheapest
// way to make the server write to disk, and the throttle counts attempts
// before the body is read.
// =============================================================================

import { assertSameOrigin, okResponse, requireApiSession, withApi } from "@/lib/api";
import { prisma } from "@/lib/db";
import { storage } from "@/lib/storage";
import { RateLimitedError, createThrottle } from "@/lib/throttle";
import { readUploadForm, storeUpload } from "@/lib/uploads";

/** 30 uploads per 10 minutes per user; process-wide, single-container (D42). */
const uploadThrottle = createThrottle({ windowMs: 10 * 60 * 1000, max: 30 });

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireApiSession();
    assertSameOrigin(request);

    const verdict = uploadThrottle.attempt(`uploads:${session.userId}`);
    if (!verdict.allowed) throw new RateLimitedError();

    const { bytes, declaredMime } = await readUploadForm(request);
    const stored = await storeUpload(prisma, storage, {
      ownerId: session.userId,
      bytes,
      declaredMime,
    });

    return okResponse(stored, { status: 201 });
  });
}
