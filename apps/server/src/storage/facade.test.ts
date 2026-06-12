import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StorageBackend, StoredObject } from "./backend.js";

type StorageModule = typeof import("../storage.js");
let storage: StorageModule;

// Simple in-memory backend with controllable mtimes.
class MemBackend implements StorageBackend {
  texts = new Map<string, string>();
  bytes = new Map<string, Buffer>();
  mtimes = new Map<string, number>();
  removed: string[] = [];
  async putText(k: string, t: string) { this.texts.set(k, t); this.mtimes.set(k, this.mtimes.get(k) ?? Date.now()); }
  async putBytes(k: string, d: Buffer) { this.bytes.set(k, d); this.mtimes.set(k, this.mtimes.get(k) ?? Date.now()); }
  async getText(k: string) { return this.texts.get(k)!; }
  async getBytes(k: string) { return this.bytes.get(k)!; }
  async statMtime(k: string) { return this.mtimes.has(k) ? this.mtimes.get(k)! : null; }
  async list(prefix: string): Promise<StoredObject[]> {
    const keys = [...this.texts.keys(), ...this.bytes.keys()].filter((k) => k.startsWith(prefix));
    return keys.map((key) => ({ key, mtimeMs: this.mtimes.get(key) ?? 0 }));
  }
  async remove(k: string) { this.removed.push(k); this.texts.delete(k); this.bytes.delete(k); }
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.TOKEN_HASH_SECRET ??= "t".repeat(32);
  storage = await import("../storage.js");
});
afterAll(() => storage.setStorageBackend(undefined));

describe("storage facade with an injected backend", () => {
  const workspaceId = "workspace_test";

  it("writes/reads blobs through the backend", async () => {
    const mem = new MemBackend();
    storage.setStorageBackend(mem);
    const { storageKey, size, hex } = await storage.writeBlob(Buffer.from("hello"), workspaceId);
    expect(size).toBe(5);
    expect(storageKey).toBe(storage.attachmentKeyForHex(hex, workspaceId));
    expect((await storage.readBlob(storageKey)).toString()).toBe("hello");
  });

  it("still reads legacy unscoped object keys", async () => {
    const mem = new MemBackend();
    storage.setStorageBackend(mem);
    const hex = "a".repeat(64);
    const legacyKey = `objects/${hex.slice(0, 2)}/${hex}.md`;
    mem.texts.set(legacyKey, "# legacy\n");
    expect(await storage.readContent(legacyKey)).toBe("# legacy\n");
  });

  it("sweep keeps referenced + too-new objects and removes aged orphans", async () => {
    const mem = new MemBackend();
    storage.setStorageBackend(mem);
    const referenced = await storage.writeContent("# keep me\n", workspaceId); // referenced by a revision
    const orphanOld = await storage.writeContent("# old orphan\n", workspaceId);
    const orphanNew = await storage.writeContent("# new orphan\n", workspaceId);
    // Age the keys: referenced + old orphan are old; new orphan is fresh.
    const old = Date.now() - 2 * 60 * 60 * 1000;
    mem.mtimes.set(referenced.storageKey, old);
    mem.mtimes.set(orphanOld.storageKey, old);
    mem.mtimes.set(orphanNew.storageKey, Date.now());

    const fakeClient = {
      documentRevision: { findMany: async () => [{ storageKey: referenced.storageKey }] },
      attachment: { findMany: async () => [] },
    } as never;

    const res = await storage.sweepOrphanObjects(fakeClient, 60 * 60 * 1000);
    expect(res.removed).toBe(1);                 // only the aged orphan
    expect(mem.removed).toEqual([orphanOld.storageKey]);
    expect(res.kept).toBe(2);                    // referenced + too-new
  });
});
