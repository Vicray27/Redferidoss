// =============================================================================
// GET /api/files/[key] — serves a stored upload (proof images/PDFs, D42).
//
// The bytes live on local disk outside the web root, so this route is the only
// way to view a proof, and it is deliberately narrow: the session is required,
// and the FILE ROW decides who may read it — its owner or any staff member.
// The key is looked up in `files` first, so a malformed key simply matches no
// row; no path is ever assembled from raw input.
//
// A third party gets the SAME 404 as a key that does not exist: the route never
// confirms that somebody else's file is out there (D45). 403 remains the answer
// for "you may not act on a thing you can see" elsewhere; here the thing itself
// must stay unacknowledged.
//
// `Cache-Control: private, no-store`: a proof can contain personal bank data
// and must not sit in a shared cache.
// =============================================================================

import { requireApiSession, withApi } from "@/lib/api";
import { isStaffActor } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { storage } from "@/lib/storage";

interface FileRow {
  key: string;
  owner_id: string | null;
  mime: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  void request;

  return withApi(async () => {
    const session = await requireApiSession();
    const { key } = await params;

    const rows = await prisma.$queryRaw<FileRow[]>`
      /* @files:by-key */
      SELECT key, owner_id, mime
      FROM files
      WHERE key = ${key}
      LIMIT 1
    `;
    const file = rows[0];
    if (!file) throw new NotFoundError("El archivo no existe.");

    const actor = { userId: session.userId, role: session.role };
    if (file.owner_id !== session.userId && !isStaffActor(actor)) {
      // Uniform with the no-row case above: existence itself is not disclosable.
      throw new NotFoundError("El archivo no existe.");
    }

    const bytes = await storage.read(file.key);
    // TS 5.7 typed arrays: `Uint8Array<ArrayBufferLike>` is not a BodyInit, so
    // the bytes are retyped with an explicit copy (≤ 10 MB, validated at upload).
    const body = new Uint8Array(bytes);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
