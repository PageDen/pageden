import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { metadataFromContent } from "./routes.js";

// Minimal stand-in for Prisma.TransactionClient — only document.findFirst is touched.
function mockTx(documents: Array<{ id: string; path: string }>) {
  const findFirst = vi.fn(async ({ where }: { where: { workspaceId: string; deletedAt: null; path: { in: string[] } } }) => {
    const wanted = new Set(where.path.in);
    return documents.find((doc) => wanted.has(doc.path.toLowerCase())) ?? null;
  });
  return { document: { findFirst }, findFirst } as unknown as Prisma.TransactionClient & {
    findFirst: typeof findFirst;
  };
}

describe("metadataFromContent", () => {
  it("defaults to canonical when frontmatter is absent", async () => {
    const tx = mockTx([]);
    const meta = await metadataFromContent(tx, "ws1", "# Just a body, no frontmatter.\n");
    expect(meta).toEqual({ status: "canonical", supersededById: null });
  });

  it("reads status from frontmatter and lowercases unknown casing", async () => {
    const tx = mockTx([]);
    const fm = "---\nstatus: Superseded\n---\n# Body";
    const meta = await metadataFromContent(tx, "ws1", fm);
    expect(meta.status).toBe("superseded");
  });

  it("falls back to canonical for unknown status values", async () => {
    const tx = mockTx([]);
    const fm = "---\nstatus: rumored\n---\n";
    const meta = await metadataFromContent(tx, "ws1", fm);
    expect(meta.status).toBe("canonical");
  });

  it("resolves supersededBy path to a document id (with or without .md)", async () => {
    const tx = mockTx([{ id: "doc-new", path: "pageden-dev/docs/new-plan.md" }]);
    const fm = "---\nstatus: superseded\nsupersededBy: pageden-dev/docs/new-plan\n---\n# Old plan";
    const meta = await metadataFromContent(tx, "ws1", fm);
    expect(meta).toEqual({ status: "superseded", supersededById: "doc-new" });
  });

  it("never points a document at itself", async () => {
    const tx = mockTx([{ id: "self", path: "docs/self.md" }]);
    const fm = "---\nsupersededBy: docs/self.md\n---\n";
    const meta = await metadataFromContent(tx, "ws1", fm, "self");
    expect(meta.supersededById).toBeNull();
  });

  it("clears supersededBy when the target cannot be resolved", async () => {
    const tx = mockTx([]);
    const fm = "---\nstatus: superseded\nsupersededBy: missing/path.md\n---\n";
    const meta = await metadataFromContent(tx, "ws1", fm);
    expect(meta).toEqual({ status: "superseded", supersededById: null });
  });
});
