import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentRevisionFindMany: vi.fn(),
  attachmentFindMany: vi.fn(),
  readContent: vi.fn(),
  writeContent: vi.fn(),
  readBlob: vi.fn(),
  writeBlob: vi.fn(),
}));

vi.mock("./prisma.js", () => ({
  prisma: {
    documentRevision: { findMany: mocks.documentRevisionFindMany },
    attachment: { findMany: mocks.attachmentFindMany },
  },
}));

vi.mock("./storage.js", () => ({
  readContent: mocks.readContent,
  writeContent: mocks.writeContent,
  readBlob: mocks.readBlob,
  writeBlob: mocks.writeBlob,
}));

import { applyDocumentStorageTransfer, copyDocumentStorageForWorkspace, updateDocumentScopedWorkspaceRows } from "./workspace-transfer.js";

describe("workspace transfer storage helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty plan without querying storage when there are no documents", async () => {
    const plan = await copyDocumentStorageForWorkspace([], "dest");
    expect(plan.revisionStorageKeys.size).toBe(0);
    expect(plan.attachmentStorageKeys.size).toBe(0);
    expect(mocks.documentRevisionFindMany).not.toHaveBeenCalled();
    expect(mocks.attachmentFindMany).not.toHaveBeenCalled();
  });

  it("copies revision content and attachment blobs into the destination workspace", async () => {
    mocks.documentRevisionFindMany.mockResolvedValue([{ id: "rev1", storageKey: "src/rev1.md" }]);
    mocks.attachmentFindMany.mockResolvedValue([{ id: "att1", storageKey: "src/att1.bin" }]);
    mocks.readContent.mockResolvedValue("# doc\n");
    mocks.writeContent.mockResolvedValue({ storageKey: "dest/rev1.md" });
    const blob = Buffer.from("file");
    mocks.readBlob.mockResolvedValue(blob);
    mocks.writeBlob.mockResolvedValue({ storageKey: "dest/att1.bin" });

    const plan = await copyDocumentStorageForWorkspace(["doc1"], "dest");

    expect(mocks.documentRevisionFindMany).toHaveBeenCalledWith({
      where: { documentId: { in: ["doc1"] } },
      select: { id: true, storageKey: true },
    });
    expect(mocks.writeContent).toHaveBeenCalledWith("# doc\n", "dest");
    expect(mocks.writeBlob).toHaveBeenCalledWith(blob, "dest");
    expect(plan.revisionStorageKeys.get("rev1")).toBe("dest/rev1.md");
    expect(plan.attachmentStorageKeys.get("att1")).toBe("dest/att1.bin");
  });

  it("applies copied storage keys and updates document-scoped workspace rows", async () => {
    const tx = {
      documentRevision: { update: vi.fn() },
      attachment: { update: vi.fn(), updateMany: vi.fn() },
      documentComment: { updateMany: vi.fn() },
      tokenReadCursor: { updateMany: vi.fn() },
      documentClaim: { updateMany: vi.fn() },
      documentShare: { updateMany: vi.fn() },
    };
    await applyDocumentStorageTransfer(tx as never, {
      revisionStorageKeys: new Map([["rev1", "dest/rev1.md"]]),
      attachmentStorageKeys: new Map([["att1", "dest/att1.bin"]]),
    });
    expect(tx.documentRevision.update).toHaveBeenCalledWith({ where: { id: "rev1" }, data: { storageKey: "dest/rev1.md" } });
    expect(tx.attachment.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { storageKey: "dest/att1.bin" } });

    await updateDocumentScopedWorkspaceRows(tx as never, ["doc1"], "dest");
    const where = { documentId: { in: ["doc1"] } };
    expect(tx.attachment.updateMany).toHaveBeenCalledWith({ where, data: { workspaceId: "dest" } });
    expect(tx.documentComment.updateMany).toHaveBeenCalledWith({ where, data: { workspaceId: "dest" } });
    expect(tx.tokenReadCursor.updateMany).toHaveBeenCalledWith({ where, data: { workspaceId: "dest" } });
    expect(tx.documentClaim.updateMany).toHaveBeenCalledWith({ where, data: { workspaceId: "dest" } });
    expect(tx.documentShare.updateMany).toHaveBeenCalledWith({ where, data: { workspaceId: "dest" } });
  });
});
