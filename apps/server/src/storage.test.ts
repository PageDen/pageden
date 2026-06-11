import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type StorageModule = typeof import("./storage.js");
let storage: StorageModule;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.SESSION_SECRET ??= "s".repeat(32);
  process.env.TOKEN_HASH_SECRET ??= "t".repeat(32);
  process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), "pm-storage-"));
  storage = await import("./storage.js");
});

describe("content-addressed storage", () => {
  it("is idempotent: identical content reuses the same key", async () => {
    const a = await storage.writeContent("# Hello\n");
    const b = await storage.writeContent("# Hello\n");
    expect(a.storageKey).toBe(b.storageKey);
    expect(a.hex).toBe(b.hex);
  });

  it("canonicalizes before hashing so CRLF and trailing newlines do not change the key", async () => {
    const lf = await storage.writeContent("line1\nline2");
    const crlf = await storage.writeContent("line1\r\nline2\r\n\r\n");
    expect(crlf.storageKey).toBe(lf.storageKey);
  });

  it("round-trips content", async () => {
    const { storageKey } = await storage.writeContent("# Roundtrip\n\nBody.\n");
    expect(await storage.readContent(storageKey)).toBe("# Roundtrip\n\nBody.\n");
  });

  it("distinct content yields distinct keys", async () => {
    const a = await storage.writeContent("alpha\n");
    const b = await storage.writeContent("beta\n");
    expect(a.storageKey).not.toBe(b.storageKey);
  });
});
