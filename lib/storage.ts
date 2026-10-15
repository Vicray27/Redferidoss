// =============================================================================
// lib/storage.ts — where a proof upload lives (D42).
//
// The spec (§2, §10.4) describes S3-compatible storage with pre-signed URLs,
// and docker-compose already carries the S3_* variables — but the MinIO
// container there is disabled (registry pull blocked) and the church server
// runs a single app + Postgres. F4a therefore ships a LOCAL-DISK driver behind
// a three-method interface (`save`/`read`/`remove` by key). The `files` table
// is the registry and its `key` is storage-agnostic, so an S3/MinIO driver
// swaps in here without touching calling code; D42 documents the trade-off
// (no pre-signed URL: bytes go through POST /api/uploads, where the server
// sniffs the magic bytes — a stronger check than trusting the MIME a client
// declares on a pre-signed PUT).
//
// Keys are generated, never user-controlled: `<uuid>.<ext>`, with the
// extension derived from the SNIFFED content type. resolveUploadPath() is the
// single gate every path goes through, so a crafted key cannot escape the
// uploads directory.
// =============================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** §10.4: the sign endpoint validates a max of 10 MB, and so do we. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadKind = "jpg" | "png" | "webp" | "pdf";

export const UPLOAD_MIME: Record<UploadKind, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

/**
 * The kind of `bytes` according to their first bytes, or null when the content
 * is not one of the four allowed types. Magic bytes are the check that cannot
 * be lied to by a `Content-Type` header.
 */
export function sniffUploadKind(bytes: Uint8Array): UploadKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) {
    return "png";
  }

  // RIFF....WEBP — bytes 4..7 carry the chunk size and are not part of the tag.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf"; // %PDF
  }

  return null;
}

export interface Storage {
  /** Persist `bytes` under a fresh generated key and return that key. */
  save(bytes: Uint8Array, kind: UploadKind): Promise<string>;
  /** The bytes behind `key`; rejects when the key or the file does not exist. */
  read(key: string): Promise<Uint8Array>;
  /** Best-effort delete, for orphan cleanup and test teardown. */
  remove(key: string): Promise<void>;
}

const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z]+)$/;

/**
 * Absolute path for `key`, refusing anything that is not a generated key.
 * Also the place a future S3 driver would convert the key into an object name.
 */
export function resolveUploadPath(rootDir: string, key: string): string {
  const extension = KEY_PATTERN.exec(key)?.[1];
  if (!extension || !(extension in UPLOAD_MIME)) {
    throw new Error(`Invalid upload key: ${JSON.stringify(key)}`);
  }
  return path.join(rootDir, key);
}

export function createLocalStorage(rootDir: string): Storage {
  return {
    async save(bytes, kind) {
      const key = `${randomUUID()}.${kind}`;
      const target = resolveUploadPath(rootDir, key);
      await mkdir(path.dirname(target), { recursive: true });
      // 'wx' refuses to overwrite: a UUID collision is a bug, never a merge.
      await writeFile(target, bytes, { flag: "wx" });
      return key;
    },

    async read(key) {
      return new Uint8Array(await readFile(resolveUploadPath(rootDir, key)));
    },

    async remove(key) {
      await rm(resolveUploadPath(rootDir, key), { force: true });
    },
  };
}

/** Process-wide driver used by the routes and services. */
export const storage: Storage = createLocalStorage(
  process.env.UPLOADS_DIR?.trim() || path.join(process.cwd(), "uploads"),
);
