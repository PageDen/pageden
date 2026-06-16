import { describe, expect, it } from "vitest";
import { documentReadablePath, normalizeReadableDocumentPath, stripDocumentExtension } from "./document-links";

describe("document links", () => {
  it("removes only a markdown extension", () => {
    expect(stripDocumentExtension("folder/readme.md")).toBe("folder/readme");
    expect(stripDocumentExtension("folder/readme")).toBe("folder/readme");
  });

  it("builds readable workspace document URLs", () => {
    expect(documentReadablePath("ws 1", "Imported from Web/Executive Summary.md")).toBe(
      "/w/ws%201/p/Imported%20from%20Web/Executive%20Summary",
    );
  });

  it("normalizes readable route params back to stored paths", () => {
    expect(normalizeReadableDocumentPath("Imported%20from%20Web/Executive%20Summary")).toBe(
      "Imported from Web/Executive Summary.md",
    );
    expect(normalizeReadableDocumentPath("docs/readme.md")).toBe("docs/readme.md");
  });
});
