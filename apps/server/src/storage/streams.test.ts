import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FsBackend } from "./fs-backend.js";
import { S3Backend } from "./s3-backend.js";
import { StorageNotFoundError } from "./backend.js";

type StorageModule = typeof import("../storage.js");
let storage: StorageModule;
let dir: string;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.TOKEN_HASH_SECRET ??= "t".repeat(32);
  storage = await import("../storage.js");
  dir = await mkdtemp(join(tmpdir(), "pageden-streams-"));
});
afterAll(async () => {
  storage.setStorageBackend(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("streamed import-zip storage", () => {
  it("fs backend round-trips streams and reports missing keys", async () => {
    const fs = new FsBackend(dir);
    const key = "import/ws_a/job_a.zip";
    await fs.putStream(key, Readable.from(Buffer.from("zip-bytes")), 9);
    const chunks: Buffer[] = [];
    for await (const chunk of await fs.getStream(key)) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("zip-bytes");
    await fs.remove(key);
    await expect(fs.getStream(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("s3 backend streams via PutObject/GetObject with the known length", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const fake = {
      async send(command: unknown) {
        const c = command as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === "GetObjectCommand") return { Body: Readable.from(Buffer.from("zip")) };
        return {};
      },
    };
    const s3 = new S3Backend(fake, "bucket");
    await s3.putStream("import/ws_b/job_b.zip", Readable.from(Buffer.from("zip")), 3);
    expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Key: "import/ws_b/job_b.zip", ContentLength: 3 } });
    const body = await s3.getStream("import/ws_b/job_b.zip");
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("zip");
  });

  it("import-zip facade validates keys and round-trips through the backend", async () => {
    storage.setStorageBackend(new FsBackend(dir));
    expect(() => storage.importZipKey("bad id!", "job")).toThrow(/malformed/);
    const key = storage.importZipKey("ws_c", "job_c");
    expect(key).toBe("import/ws_c/job_c.zip");
    await expect(storage.writeImportZip("nope.zip", Readable.from(Buffer.alloc(1)), 1)).rejects.toThrow(/malformed/);
    await storage.writeImportZip(key, Readable.from(Buffer.from("hello")), 5);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.readImportZipStream(key)) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    await storage.removeImportZip(key);
    await expect(storage.readImportZipStream(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});
