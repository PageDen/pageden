import { describe, expect, it } from "vitest";
import { canonicalize, checksum } from "./checksum.js";

describe("checksum canonicalization", () => {
  it("normalizes CRLF and CR to LF", () => {
    expect(canonicalize("a\r\nb\rc")).toBe("a\nb\nc\n");
  });

  it("keeps exactly one trailing newline", () => {
    expect(canonicalize("a")).toBe("a\n");
    expect(canonicalize("a\n\n")).toBe("a\n");
    expect(canonicalize("")).toBe("\n");
  });

  it("preserves trailing spaces and does not normalize unicode composition", () => {
    expect(canonicalize("a  ")).toBe("a  \n");
    expect(checksum("\u00e9")).not.toBe(checksum("e\u0301"));
  });
});
