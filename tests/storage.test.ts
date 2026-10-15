import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_BYTES,
  createLocalStorage,
  resolveUploadPath,
  sniffUploadKind,
  type UploadKind,
} from "@/lib/storage";

/**
 * The storage layer is the last line between an upload and the disk: keys are
 * generated (never user-controlled), the content type comes from the magic
 * bytes, and every path crosses resolveUploadPath's pattern. These tests use a
 * real temp directory — the behaviour under test IS the filesystem.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const TEXT = new TextEncoder().encode("Hola, soy un archivo de texto disfrazado.");

const UUID = "11111111-2222-4333-8444-555555555555";

describe("sniffUploadKind", () => {
  it.each([
    ["jpg", JPEG],
    ["png", PNG],
    ["webp", WEBP],
    ["pdf", PDF],
  ] as Array<[UploadKind, Uint8Array]>)("recognises %s by its magic bytes", (kind, bytes) => {
    expect(sniffUploadKind(bytes)).toBe(kind);
  });

  it("refuses content that is not one of the four allowed types", () => {
    expect(sniffUploadKind(TEXT)).toBeNull();
    expect(sniffUploadKind(new Uint8Array(0))).toBeNull();
  });

  it("refuses truncated signatures instead of guessing", () => {
    expect(sniffUploadKind(PNG.slice(0, 7))).toBeNull();
    expect(sniffUploadKind(WEBP.slice(0, 11))).toBeNull();
    expect(sniffUploadKind(new Uint8Array([0x50, 0x44, 0x46, 0x25]))).toBeNull();
  });
});

describe("resolveUploadPath", () => {
  it("accepts a generated key and anchors it under the root", () => {
    const resolved = resolveUploadPath("C:/uploads", `${UUID}.png`);
    expect(resolved).toBe(path.join("C:/uploads", `${UUID}.png`));
  });

  it.each([
    "not-a-uuid.pdf",
    "../../etc/passwd",
    `${UUID}.exe`,
    `${UUID}.pdf/../../escape`,
    `${UUID}`,
    `${UUID}.PNG`,
  ])("refuses the crafted key %s", (key) => {
    expect(() => resolveUploadPath("C:/uploads", key)).toThrow(/Invalid upload key/);
  });
});

describe("createLocalStorage", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "refnet-uploads-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("caps uploads at the 10 MB the spec's sign endpoint validates", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it("round-trips bytes through save and read", async () => {
    const storage = createLocalStorage(root);
    const key = await storage.save(PNG, "png");

    expect(key).toMatch(new RegExp(`^[0-9a-f-]{36}\\.png$`));
    await expect(storage.read(key)).resolves.toEqual(PNG);
  });

  it("removes the object and then refuses to read it", async () => {
    const storage = createLocalStorage(root);
    const key = await storage.save(PDF, "pdf");

    await storage.remove(key);
    await expect(storage.read(key)).rejects.toThrow();
  });

  it("never reuses a key, even for identical bytes", async () => {
    const storage = createLocalStorage(root);
    const first = await storage.save(PNG, "png");
    const second = await storage.save(PNG, "png");
    expect(first).not.toBe(second);
  });
});
