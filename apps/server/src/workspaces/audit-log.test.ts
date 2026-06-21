import { describe, expect, it } from "vitest";
import { csvCell, redactAuditMetadata } from "./audit-log.js";

describe("redactAuditMetadata", () => {
  it("returns null for non-objects", () => {
    expect(redactAuditMetadata(null)).toBeNull();
    expect(redactAuditMetadata("x")).toBeNull();
    expect(redactAuditMetadata([1, 2])).toBeNull();
  });

  it("redacts sensitive-looking keys, keeps the rest", () => {
    const out = redactAuditMetadata({ tokenHash: "abc", apiKey: "k", password: "p", action: "rename", count: 3, ok: true });
    expect(out).toMatchObject({ tokenHash: "[redacted]", apiKey: "[redacted]", password: "[redacted]", action: "rename", count: 3, ok: true });
  });

  it("truncates long strings", () => {
    const out = redactAuditMetadata({ note: "a".repeat(600) });
    const note = String(out?.note ?? "");
    expect(note.length).toBeLessThanOrEqual(501);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("csvCell", () => {
  it("quotes values with commas, quotes, or newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });
});
