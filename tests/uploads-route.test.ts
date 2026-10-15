import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The upload endpoint is glue (session → throttle → form → storeUpload), so
 * the test mocks exactly its three seams and asserts the contract: the §10
 * envelopes, the 201 payload, the throttle, and that a rejected file never
 * reaches storage. The service's own rejections live in tests/uploads.test.ts.
 * GET /api/files/[key] (D45) shares those seams, so its ACL is pinned here too.
 */

vi.mock("@/lib/auth/require", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, storage: { save: vi.fn(), read: vi.fn(), remove: vi.fn() } };
});

import { GET } from "@/app/api/files/[key]/route";
import { POST } from "@/app/api/uploads/route";
import { getSession } from "@/lib/auth/require";
import type { SessionPayload } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { storage } from "@/lib/storage";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RATE_USER_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "22222222-2222-4222-8222-222222222222.png";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const TEXT = new TextEncoder().encode("no soy un comprobante");

const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const saveMock = vi.mocked(storage.save);
const readMock = vi.mocked(storage.read);

function signIn(userId: string | null, role = "MEMBER"): void {
  vi.mocked(getSession).mockResolvedValue(userId ? ({ userId, role } as SessionPayload) : null);
}

function uploadRequest(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  form.append("file", new File([bytes], "comprobante.png", { type }));
  return new Request("https://red.example/api/uploads", { method: "POST", body: form, headers });
}

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  queryRawMock.mockReset();
  queryRawMock.mockResolvedValue([{ id: "file-1" }]);
  saveMock.mockReset();
  saveMock.mockResolvedValue(KEY);
  readMock.mockReset();
  readMock.mockResolvedValue(PNG);
});

describe("POST /api/uploads", () => {
  it("rejects an unauthenticated request with the §10 401 envelope", async () => {
    signIn(null);

    const response = await POST(uploadRequest(PNG, "image/png"));
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("rejects a file whose content is not an allowed type, before storage", async () => {
    signIn(USER_ID);

    const response = await POST(uploadRequest(TEXT, "text/plain"));
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(saveMock).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("stores a valid upload and answers 201 with the file registration", async () => {
    signIn(USER_ID);

    const response = await POST(uploadRequest(PNG, "image/png"));
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      data: { fileId: "file-1", key: KEY, mime: "image/png", sizeBytes: PNG.length },
    });

    expect(saveMock).toHaveBeenCalledWith(PNG, "png");

    const insertCall = queryRawMock.mock.calls.at(-1) as unknown[];
    const sql = String((insertCall[0] as TemplateStringsArray).join(""));
    expect(sql).toContain("INSERT INTO files");
    expect(insertCall.slice(1)[0]).toBe(KEY);
    expect(insertCall.slice(1)[1]).toBe(USER_ID);
  });

  it("refuses a cross-origin request with 403", async () => {
    signIn(USER_ID);

    const response = await POST(
      uploadRequest(PNG, "image/png", { origin: "https://evil.example", host: "red.example" }),
    );
    expect(response.status).toBe(403);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("throttles the user at 30 uploads per window", async () => {
    signIn(RATE_USER_ID);

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      expect((await POST(uploadRequest(PNG, "image/png"))).status, `attempt ${attempt}`).toBe(201);
    }

    const limited = await POST(uploadRequest(PNG, "image/png"));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
    expect(saveMock).toHaveBeenCalledTimes(30);
  });
});

describe("GET /api/files/[key]", () => {
  const fileRow = (owner: string) => [{ key: KEY, owner_id: owner, mime: "image/png" }];
  const getFile = () =>
    GET(new Request(`https://red.example/api/files/${KEY}`), { params: Promise.resolve({ key: KEY }) });

  it("serves the bytes to the owner", async () => {
    signIn(USER_ID);
    queryRawMock.mockResolvedValue(fileRow(USER_ID));

    const response = await getFile();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("serves any file to a staff session", async () => {
    signIn(RATE_USER_ID, "ADMIN");
    queryRawMock.mockResolvedValue(fileRow(USER_ID));

    expect((await getFile()).status).toBe(200);
  });

  it("refuses a third party with 403 and never reads storage", async () => {
    signIn(RATE_USER_ID);
    queryRawMock.mockResolvedValue(fileRow(USER_ID));

    const response = await getFile();

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(readMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a key with no row", async () => {
    signIn(USER_ID);
    queryRawMock.mockResolvedValue([]);

    const response = await getFile();

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
    expect(readMock).not.toHaveBeenCalled();
  });
});
