import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/errors";
import { MAX_UPLOAD_BYTES, type Storage, type UploadKind } from "@/lib/storage";
import { readUploadForm, storeUpload, type UploadDb } from "@/lib/uploads";

/**
 * storeUpload owns every rejection an upload can hit and the one INSERT that
 * registers it; the fake db records the SQL so the parameterisation (owner,
 * sniffed MIME, size, checksum) is asserted, not assumed. The storage fake
 * records saves so the "orphan bytes are removed" promise is testable too.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const TEXT = new TextEncoder().encode("no soy una imagen");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222.png";

interface Recorded {
  sql: string;
  values: unknown[];
}

class UploadFakeDb implements UploadDb {
  readonly calls: Recorded[] = [];
  rows: Array<{ id: string }> = [{ id: "file-1" }];
  failure: Error | null = null;

  async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    this.calls.push({ sql: strings.join(""), values });
    if (this.failure) throw this.failure;
    return this.rows as T;
  }
}

function memoryStorage() {
  const saved: Array<{ kind: UploadKind; size: number }> = [];
  const removed: string[] = [];
  const store: Storage = {
    save: async (bytes, kind) => {
      saved.push({ kind, size: bytes.length });
      return KEY;
    },
    read: async () => new Uint8Array(),
    remove: async (key) => {
      removed.push(key);
    },
  };
  return { store, saved, removed };
}

describe("storeUpload", () => {
  it("saves the bytes and registers the file with the sniffed MIME", async () => {
    const db = new UploadFakeDb();
    const { store, saved } = memoryStorage();

    const result = await storeUpload(db, store, {
      ownerId: OWNER_ID,
      bytes: PNG,
      declaredMime: "image/png",
    });

    expect(result).toEqual({ fileId: "file-1", key: KEY, mime: "image/png", sizeBytes: PNG.length });
    expect(saved).toEqual([{ kind: "png", size: PNG.length }]);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain("INSERT INTO files");
    expect(db.calls[0].sql).toContain("RETURNING id");
    const [key, ownerId, mime, size, checksum] = db.calls[0].values;
    expect(key).toBe(KEY);
    expect(ownerId).toBe(OWNER_ID);
    expect(mime).toBe("image/png");
    expect(size).toBe(PNG.length);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts an empty declared MIME but rejects one that contradicts the content", async () => {
    const db = new UploadFakeDb();
    const { store } = memoryStorage();

    await expect(
      storeUpload(db, store, { ownerId: OWNER_ID, bytes: PNG, declaredMime: "" }),
    ).resolves.toMatchObject({ mime: "image/png" });

    for (const declaredMime of ["application/pdf", "image/jpeg", "text/plain"]) {
      await expect(
        storeUpload(db, store, { ownerId: OWNER_ID, bytes: PNG, declaredMime }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("refuses empty bytes before touching storage or the database", async () => {
    const db = new UploadFakeDb();
    const { store, saved } = memoryStorage();

    await expect(
      storeUpload(db, store, { ownerId: OWNER_ID, bytes: new Uint8Array(0), declaredMime: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: "El archivo está vacío." });

    expect(saved).toHaveLength(0);
    expect(db.calls).toHaveLength(0);
  });

  it("refuses anything above 10 MB before touching storage or the database", async () => {
    const db = new UploadFakeDb();
    const { store, saved } = memoryStorage();

    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    tooBig.set(PNG, 0);

    await expect(
      storeUpload(db, store, { ownerId: OWNER_ID, bytes: tooBig, declaredMime: "image/png" }),
    ).rejects.toMatchObject({ message: "El archivo supera el máximo de 10 MB." });

    expect(saved).toHaveLength(0);
    expect(db.calls).toHaveLength(0);
  });

  it("refuses content that is not an allowed type", async () => {
    const { store } = memoryStorage();

    await expect(
      storeUpload(new UploadFakeDb(), store, { ownerId: OWNER_ID, bytes: TEXT, declaredMime: "text/plain" }),
    ).rejects.toMatchObject({
      message: "El archivo debe ser una imagen JPG, PNG, WEBP o un PDF.",
    });
  });

  it("removes the saved bytes again when the INSERT fails", async () => {
    const db = new UploadFakeDb();
    const { store, removed } = memoryStorage();
    db.failure = new Error("insert exploded");

    await expect(
      storeUpload(db, store, { ownerId: OWNER_ID, bytes: PNG, declaredMime: "image/png" }),
    ).rejects.toThrow("insert exploded");

    expect(removed).toEqual([KEY]);
  });
});

describe("readUploadForm", () => {
  function multipartRequest(bytes: Uint8Array<ArrayBuffer>, type: string): Request {
    const form = new FormData();
    form.append("file", new File([bytes], "comprobante.png", { type }));
    return new Request("https://red.example/api/uploads", { method: "POST", body: form });
  }

  it("reads the bytes and the declared MIME of the file field", async () => {
    const parsed = await readUploadForm(multipartRequest(PNG, "image/png"));
    expect(parsed.declaredMime).toBe("image/png");
    expect(parsed.bytes).toEqual(PNG);
  });

  it("rejects a body that is not multipart with the field", async () => {
    const json = new Request("https://red.example/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expect(readUploadForm(json)).rejects.toThrow(ValidationError);
  });

  it("rejects multipart without the file field", async () => {
    const form = new FormData();
    form.append("not-file", "plain");
    const request = new Request("https://red.example/api/uploads", { method: "POST", body: form });
    await expect(readUploadForm(request)).rejects.toMatchObject({
      message: 'El campo "file" es obligatorio.',
    });
  });
});
