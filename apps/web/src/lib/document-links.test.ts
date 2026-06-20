import { describe, expect, it } from "vitest";
import {
  documentDeepLink,
  documentReadablePath,
  documentReviewNote,
  normalizeReadableDocumentPath,
  stripDocumentExtension,
  workspaceRelativePath,
} from "./document-links";

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

  it("returns the verbatim agent path, dropping only a leading slash", () => {
    expect(workspaceRelativePath("docs/foo.md")).toBe("docs/foo.md");
    expect(workspaceRelativePath("/docs/foo.md")).toBe("docs/foo.md");
  });

  it("builds a stable id-based deep link from an explicit origin", () => {
    expect(documentDeepLink("ws 1", "doc 9", "https://acme.pageden.app")).toBe(
      "https://acme.pageden.app/w/ws%201/d/doc%209",
    );
  });

  it("composes a review note with both references and an agent hint", () => {
    expect(
      documentReviewNote({
        workspaceId: "acme",
        documentId: "doc1",
        path: "docs/foo.md",
        origin: "https://acme.pageden.app",
      }),
    ).toBe(
      [
        "Please review: docs/foo.md",
        "https://acme.pageden.app/w/acme/d/doc1",
        "",
        '(Agent: read with pageden_read_document path="docs/foo.md")',
      ].join("\n"),
    );
  });
});
