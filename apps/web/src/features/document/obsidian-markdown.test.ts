import { describe, expect, it } from "vitest";
import { resolveWikiLinks } from "./document-editor";

describe("Obsidian markdown compatibility", () => {
  const tree = {
    documents: [
      {
        id: "doc1",
        folderId: "folder1",
        title: "Runbook",
        path: "engineering/runbook.md",
        permission: "editor" as const,
        version: "rev1",
        checksum: "sha256:x",
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    ],
  };

  it("turns wiki links into workspace document links", () => {
    expect(resolveWikiLinks("See [[Runbook|the runbook]].", "ws1", tree)).toBe(
      "See [the runbook](/w/ws1/d/doc1).",
    );
  });

  it("keeps unresolved wiki links readable and converts Obsidian embeds to Markdown images", () => {
    expect(resolveWikiLinks("See [[Missing]]\n![[diagram.png|Diagram]]", "ws1", tree)).toBe(
      "See Missing\n![Diagram](diagram.png)",
    );
  });
});
