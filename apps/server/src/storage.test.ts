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
  const workspaceId = "workspace_test";

  it("is idempotent: identical content reuses the same key", async () => {
    const a = await storage.writeContent("# Hello\n", workspaceId);
    const b = await storage.writeContent("# Hello\n", workspaceId);
    expect(a.storageKey).toBe(b.storageKey);
    expect(a.hex).toBe(b.hex);
  });

  it("scopes keys by workspace so tenant cleanup has a clear prefix", async () => {
    const a = await storage.writeContent("# Hello\n", "workspace_a");
    const b = await storage.writeContent("# Hello\n", "workspace_b");
    expect(a.hex).toBe(b.hex);
    expect(a.storageKey).toBe(`workspaces/workspace_a/objects/${a.hex.slice(0, 2)}/${a.hex}.md`);
    expect(b.storageKey).toBe(`workspaces/workspace_b/objects/${b.hex.slice(0, 2)}/${b.hex}.md`);
  });

  it("canonicalizes before hashing so CRLF and trailing newlines do not change the key", async () => {
    const lf = await storage.writeContent("line1\nline2", workspaceId);
    const crlf = await storage.writeContent("line1\r\nline2\r\n\r\n", workspaceId);
    expect(crlf.storageKey).toBe(lf.storageKey);
  });

  it("round-trips content", async () => {
    const { storageKey } = await storage.writeContent("# Roundtrip\n\nBody.\n", workspaceId);
    expect(await storage.readContent(storageKey)).toBe("# Roundtrip\n\nBody.\n");
  });

  it("distinct content yields distinct keys", async () => {
    const a = await storage.writeContent("alpha\n", workspaceId);
    const b = await storage.writeContent("beta\n", workspaceId);
    expect(a.storageKey).not.toBe(b.storageKey);
  });
});
