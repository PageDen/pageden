import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { strToU8, zipSync } from "fflate";
import { Readable } from "node:stream";
import type { StorageBackend, StoredObject } from "../storage/backend.js";

type StorageModule = typeof import("../storage.js");
type VaultModule = typeof import("./vault.js");
let storage: StorageModule;
let vault: VaultModule;

class MemBackend implements StorageBackend {
  bytes = new Map<string, Buffer>();
  async putText(k: string, t: string) { this.bytes.set(k, Buffer.from(t)); }
  async putBytes(k: string, d: Buffer) { this.bytes.set(k, d); }
  async getText(k: string) { return this.bytes.get(k)!.toString("utf8"); }
  async getBytes(k: string) { return this.bytes.get(k)!; }
  async statMtime(k: string) { return this.bytes.has(k) ? 1 : null; }
  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.bytes.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, mtimeMs: 1 }));
  }
  async remove(k: string) { this.bytes.delete(k); }
  async putStream(k: string, data: Readable, _length: number) {
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk as Buffer));
    this.bytes.set(k, Buffer.concat(chunks));
  }
  async getStream(k: string): Promise<Readable> {
    return Readable.from(this.bytes.get(k) ?? Buffer.alloc(0));
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.TOKEN_HASH_SECRET ??= "t".repeat(32);
  storage = await import("../storage.js");
  vault = await import("./vault.js");
});
afterAll(() => storage.setStorageBackend(undefined));

describe("import path helpers", () => {
  it("rejects zip-slip paths and accepts normal ones", () => {
    expect(vault.isUnsafeZipPath("../evil.md")).toBe(true);
    expect(vault.isUnsafeZipPath("a/../../evil.md")).toBe(true);
    expect(vault.isUnsafeZipPath("/abs/path.md")).toBe(true);
    expect(vault.isUnsafeZipPath("C:/windows.md")).toBe(true);
    expect(vault.isUnsafeZipPath("a/../b.md")).toBe(false); // stays inside the root
    expect(vault.isUnsafeZipPath("vault/notes/hello.md")).toBe(false);
  });

  it("normalizes paths and ignores vault internals", () => {
    expect(vault.normalizePath("a\\b//c/./..")).toContain("a/b");
    expect(vault.isIgnoredPath("vault/.obsidian/app.json")).toBe(true);
    expect(vault.isIgnoredPath("vault/.trash/x.md")).toBe(true);
    expect(vault.isIgnoredPath("vault/.git/config")).toBe(true);
    expect(vault.isIgnoredPath("vault/notes/x.md")).toBe(false);
  });

  it("slugifies like the web importer", () => {
    expect(vault.slugifyImport("Héllo World.md")).toBe("hello-world");
    expect(vault.slugifyImport("___")).toBe("untitled");
  });

  it("extracts wiki and markdown attachment refs", () => {
    const refs = vault.extractAttachmentRefs(
      "![[diagram.png]] and ![[img.png|caption]] plus ![alt](photo%20one.jpg) but not ![ext](https://x/y.png)",
    );
    expect(refs).toContain("diagram.png");
    expect(refs).toContain("img.png");
    expect(refs).toContain("photo one.jpg");
    expect(refs).not.toContain("https://x/y.png");
  });
});

describe("zip scanning limits", () => {
  function storeZip(entries: Record<string, Uint8Array>): string {
    const mem = new MemBackend();
    storage.setStorageBackend(mem);
    const key = "import/ws_test/job_test.zip";
    mem.bytes.set(key, Buffer.from(zipSync(entries)));
    return key;
  }

  it("streams entries and enforces the per-file cap", async () => {
    process.env.IMPORT_MAX_FILE_MB = "1";
    try {
      const key = storeZip({ "big.bin": new Uint8Array(2 * 1024 * 1024) });
      await expect(
        vault.scanZipForTests(key, { wantData: () => true, onEntry: () => {} }),
      ).rejects.toThrow(/per-file limit/);
    } finally {
      delete process.env.IMPORT_MAX_FILE_MB;
    }
  });

  it("enforces the entry-count cap and rejects unsafe entries", async () => {
    process.env.IMPORT_MAX_ENTRIES = "1";
    try {
      const key = storeZip({ "a.md": strToU8("# a"), "b.md": strToU8("# b") });
      await expect(vault.scanZipForTests(key, { wantData: () => false, onEntry: () => {} })).rejects.toThrow(/too many entries/);
    } finally {
      delete process.env.IMPORT_MAX_ENTRIES;
    }
    const key = storeZip({ "../evil.md": strToU8("# evil") });
    await expect(vault.scanZipForTests(key, { wantData: () => false, onEntry: () => {} })).rejects.toThrow(/unsafe path/);
  });

  it("delivers wanted data and skips unwanted data", async () => {
    const key = storeZip({ "note.md": strToU8("# hi"), "img.png": new Uint8Array([1, 2, 3]), "dir/": new Uint8Array(0) });
    const seen: Array<{ path: string; hasData: boolean }> = [];
    await vault.scanZipForTests(key, {
      wantData: (path) => path.endsWith(".md"),
      onEntry: (path, data) => seen.push({ path, hasData: data !== null }),
    });
    expect(seen).toContainEqual({ path: "note.md", hasData: true });
    expect(seen).toContainEqual({ path: "img.png", hasData: false });
    expect(seen.find((s) => s.path === "dir/")).toBeUndefined();
  });
});
