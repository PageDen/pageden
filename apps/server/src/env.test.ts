import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

async function loadEnv(overrides: NodeJS.ProcessEnv = {}) {
  vi.resetModules();
  process.env = {
    ...originalEnv,
    DATABASE_URL: "postgresql://pageden@localhost:5432/pageden_test",
    SESSION_SECRET: "s".repeat(32),
    TOKEN_HASH_SECRET: "t".repeat(32),
    APP_URL: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:3000",
    STORAGE_DRIVER: "fs",
    CLOUD_HOSTED: "false",
    ...overrides,
  };
  return import("./env.js");
}

describe("env validation", () => {
  it("rejects invalid URL origins", async () => {
    await expect(loadEnv({ APP_URL: "not a url" })).rejects.toThrow("Expected a valid URL origin");
  });

  it("rejects invalid boolean values", async () => {
    await expect(loadEnv({ SPACES_FORCE_PATH_STYLE: "sometimes" })).rejects.toThrow("SPACES_FORCE_PATH_STYLE must be true or false.");
  });

  it("requires storage credentials for spaces", async () => {
    await expect(loadEnv({ STORAGE_DRIVER: "spaces" })).rejects.toThrow("STORAGE_DRIVER=spaces requires");
  });

  it("requires a base domain for cloud-hosted mode", async () => {
    await expect(loadEnv({ CLOUD_HOSTED: "true", BASE_DOMAIN: "" })).rejects.toThrow("BASE_DOMAIN is required");
  });

  it("requires production secrets to be changed", async () => {
    await expect(loadEnv({ NODE_ENV: "production", SESSION_SECRET: "replace-in-development" })).rejects.toThrow("SESSION_SECRET must be at least");
  });
});
