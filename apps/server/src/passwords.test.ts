import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("password helpers", () => {
  it("verifies valid hashes and returns false for invalid hash strings", async () => {
    const hash = await hashPassword("correct horse battery staple");

    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword("not-a-real-argon-hash", "anything")).resolves.toBe(false);
  });
});
