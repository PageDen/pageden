import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BASE = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_HASH_SECRET: "t".repeat(32),
};

const saved = { ...process.env };
beforeEach(() => { vi.resetModules(); process.env = { ...BASE } as NodeJS.ProcessEnv; });
afterEach(() => { process.env = { ...saved }; });

describe("STORAGE_DRIVER configuration", () => {
  it("defaults to the filesystem backend", async () => {
    const { createBackend } = await import("../storage.js");
    expect(createBackend().constructor.name).toBe("FsBackend");
  });

  it("builds the Spaces backend when configured", async () => {
    process.env.STORAGE_DRIVER = "spaces";
    process.env.SPACES_BUCKET = "pageden-staging";
    process.env.SPACES_REGION = "sgp1";
    process.env.SPACES_ENDPOINT = "https://sgp1.digitaloceanspaces.com";
    process.env.SPACES_ACCESS_KEY_ID = "AKID";
    process.env.SPACES_SECRET_ACCESS_KEY = "SECRET";
    const { createBackend } = await import("../storage.js");
    expect(createBackend().constructor.name).toBe("S3Backend");
  });

  it("rejects an unknown driver", async () => {
    process.env.STORAGE_DRIVER = "ftp";
    await expect(import("../storage.js")).rejects.toThrow(/STORAGE_DRIVER/);
  });

  it("requires Spaces credentials when driver=spaces", async () => {
    process.env.STORAGE_DRIVER = "spaces"; // no bucket/keys
    await expect(import("../storage.js")).rejects.toThrow(/SPACES_BUCKET/);
  });
});
