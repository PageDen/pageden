import { describe, expect, it } from "vitest";
import { createRawToken, hashToken, TOKEN_PREFIX } from "./tokens.js";

describe("plugin token hashing", () => {
  it("hashes deterministically with the supplied secret", () => {
    const first = hashToken(`${TOKEN_PREFIX}example`, "a".repeat(32));
    const second = hashToken(`${TOKEN_PREFIX}example`, "a".repeat(32));

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not require unrelated environment variables at import time", () => {
    expect(hashToken(`${TOKEN_PREFIX}example`, "b".repeat(32))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates prefixed raw tokens", () => {
    expect(createRawToken()).toMatch(/^pm_live_[A-Za-z0-9_-]+$/);
  });
});
