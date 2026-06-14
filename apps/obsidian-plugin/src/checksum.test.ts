import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, checksum } from "./checksum";

Object.defineProperty(globalThis, "activeWindow", { value: { crypto: webcrypto }, configurable: true });

describe("plugin checksum", () => {
  it("canonicalizes CRLF, bare CR, empty, and trailing-newline variants", async () => {
    expect(canonicalize("a\r\nb\r")).toBe("a\nb\n");
    expect(canonicalize("")).toBe("\n");
    expect(canonicalize("a\n\n\n")).toBe("a\n");
    const expected = createHash("sha256").update("a\nb\n", "utf8").digest("hex");
    await expect(checksum("a\r\nb")).resolves.toBe(`sha256:${expected}`);
  });
});
