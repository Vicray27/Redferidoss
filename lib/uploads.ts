// =============================================================================
// lib/uploads.ts — the §10.4 upload pipeline: parse → sniff → save → register.
//
// `storeUpload` is the whole flow with its dependencies injected (db and
// storage), so tests assert the SQL and every rejection without a filesystem
// or a database — the same shape as lib/network.ts. The route handler stays
// glue: session, throttle, form parse, call this.
//
// The order matters. Size is checked before anything touches the disk; the
// magic bytes are checked before the declared MIME, because the declared MIME
// is exactly the value a malicious client controls. A file that is saved but
// cannot be registered (the INSERT failed) is removed again, so `files:gc`
// only ever has to chase objects older than the failure that orphaned them.
// =============================================================================

import { createHash } from "node:crypto";

import { ValidationError } from "./errors";
import { MAX_UPLOAD_BYTES, UPLOAD_MIME, sniffUploadKind, type Storage } from "./storage";

/** Minimal raw-query client, same structural type as lib/users.ts. */
export interface UploadDb {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface UploadResult {
  fileId: string;
  key: string;
  mime: string;
  sizeBytes: number;
}

export interface StoreUploadInput {
  ownerId: string;
  bytes: Uint8Array;
  declaredMime: string;
}

export interface ParsedUploadForm {
  bytes: Uint8Array;
  declaredMime: string;
}

/**
 * Read the `file` field of a multipart/form-data body.
 *
 * The upload endpoint is the one place where the client sends a body too big
 * for a Server Action (Next caps action bodies at 1 MB), which is why the file
 * travels through a route handler and the form then submits only the fileId.
 */
export async function readUploadForm(request: Request): Promise<ParsedUploadForm> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError(
      'El cuerpo de la solicitud debe ser multipart/form-data con el campo "file".',
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError('El campo "file" es obligatorio.');
  }

  return { bytes: new Uint8Array(await file.arrayBuffer()), declaredMime: file.type };
}

/** SHA-256 hex of the stored bytes, for the `files.checksum` column. */
function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate, persist and register one proof file. Returns the `files.id` the
 * caller links to (payments.proof_key stores the key; weekly reports store
 * `fileId`), plus what the UI needs to confirm the upload.
 */
export async function storeUpload(
  db: UploadDb,
  store: Storage,
  input: StoreUploadInput,
): Promise<UploadResult> {
  const { bytes, declaredMime } = input;

  if (bytes.length === 0) {
    throw new ValidationError("El archivo está vacío.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ValidationError("El archivo supera el máximo de 10 MB.");
  }

  const kind = sniffUploadKind(bytes);
  if (!kind) {
    throw new ValidationError("El archivo debe ser una imagen JPG, PNG, WEBP o un PDF.");
  }

  const mime = UPLOAD_MIME[kind];
  if (declaredMime && declaredMime !== mime) {
    throw new ValidationError("El tipo declarado del archivo no coincide con su contenido.");
  }

  const key = await store.save(bytes, kind);

  try {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      /* @upload:insert-file */
      INSERT INTO files (key, owner_id, mime, size_bytes, checksum)
      VALUES (${key}, ${input.ownerId}::uuid, ${mime}, ${bytes.length}, ${checksumOf(bytes)})
      RETURNING id
    `;
    const fileId = rows[0]?.id;
    if (!fileId) throw new Error("The files INSERT returned no row");
    return { fileId, key, mime, sizeBytes: bytes.length };
  } catch (error) {
    // The bytes are on disk but unregistered. Remove them so the orphan is
    // bounded by this failure, then surface the real error to the caller.
    await store.remove(key).catch(() => {});
    throw error;
  }
}
