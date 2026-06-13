import { describe, expect, it } from "vitest";
import { buildDownloadMarkdown, contentDisposition, downloadFilename } from "./download.js";

const meta = {
  title: "Deploy Runbook",
  path: "engineering/deploy-runbook.md",
  version: "rev_42",
  updatedAt: "2026-06-04T08:00:00.000Z",
  checksum: "sha256:abc123",
};

describe("buildDownloadMarkdown", () => {
  it("prepends server-managed frontmatter to a plain body", () => {
    const out = buildDownloadMarkdown(meta, "# Deploy Runbook\n\nSteps go here.\n");
    expect(out).toBe(
      [
        "---",
        'title: "Deploy Runbook"',
        'path: "engineering/deploy-runbook.md"',
        'version: "rev_42"',
        'updatedAt: "2026-06-04T08:00:00.000Z"',
        'checksum: "sha256:abc123"',
        "---",
        "",
        "# Deploy Runbook",
        "",
        "Steps go here.",
        "",
      ].join("\n"),
    );
  });

  it("strips the stored frontmatter fence and preserves non-reserved keys", () => {
    const stored = ["---", "title: Old Title", "tags: [a, b]", "owner: chris", "---", "", "Body here.", ""].join("\n");
    const out = buildDownloadMarkdown(meta, stored);
    // Server title wins; the original fence is not duplicated; extra keys are kept.
    expect(out).toContain('title: "Deploy Runbook"');
    expect(out).not.toContain("Old Title");
    expect(out).toContain('owner: "chris"');
    expect(out).toContain('tags: ["a", "b"]');
    expect(out.match(/^---$/gm)?.length).toBe(2); // exactly one frontmatter block
    expect(out.endsWith("Body here.\n")).toBe(true);
  });

  it("omits version and checksum when absent and ends with one trailing LF", () => {
    const out = buildDownloadMarkdown({ ...meta, version: null, checksum: null }, "");
    expect(out).not.toContain("version:");
    expect(out).not.toContain("checksum:");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("escapes quotes and backslashes in scalar values", () => {
    const out = buildDownloadMarkdown({ ...meta, title: 'A "quoted" \\ title' }, "x\n");
    expect(out).toContain('title: "A \\"quoted\\" \\\\ title"');
  });
});

describe("downloadFilename", () => {
  it("uses the path basename and ensures a .md extension", () => {
    expect(downloadFilename("engineering/deploy-runbook.md")).toBe("deploy-runbook.md");
    expect(downloadFilename("notes/todo")).toBe("todo.md");
    expect(downloadFilename("")).toBe("document.md");
  });
});

describe("contentDisposition", () => {
  it("emits an attachment header with ascii and UTF-8 filename forms", () => {
    expect(contentDisposition("deploy-runbook.md")).toBe(
      "attachment; filename=\"deploy-runbook.md\"; filename*=UTF-8''deploy-runbook.md",
    );
  });
});
