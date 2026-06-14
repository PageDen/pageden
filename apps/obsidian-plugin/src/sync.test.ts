import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PagedenApiError } from "./api-client";
import {
  createRemoteDocumentFromLocal,
  downloadDocument,
  extractAttachmentPaths,
  localPathForRemote,
  pushLocalDocument,
  pushOrCreateLocalDocument,
  runBackgroundSyncPass,
  syncDocumentAttachments,
  syncLinkedDocument,
  type VaultLike,
} from "./sync";
import { checksum } from "./checksum";
import type { Attachment, RemoteDocumentWithContent, ServerMetaAttachmentEntry, ServerMetaEntry } from "./types";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

class MemoryVault implements VaultLike {
  files = new Map<string, string>();
  binaryFiles = new Map<string, ArrayBuffer>();
  folders = new Set<string>();

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binaryFiles.get(path);
    if (value === undefined) throw new Error("missing binary");
    return value;
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaryFiles.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
}

class MemoryMeta {
  entries = new Map<string, ServerMetaEntry>();
  attachments = new Map<string, ServerMetaAttachmentEntry>();

  async list(): Promise<ServerMetaEntry[]> {
    return [...this.entries.values()];
  }

  async getByLocalPath(path: string): Promise<ServerMetaEntry | null> {
    return [...this.entries.values()].find((entry) => entry.localPath === path) ?? null;
  }

  async upsert(entry: ServerMetaEntry): Promise<void> {
    this.entries.set(entry.documentId, entry);
  }

  async listAttachmentsForDocument(documentId: string): Promise<ServerMetaAttachmentEntry[]> {
    return [...this.attachments.values()].filter((entry) => entry.documentId === documentId);
  }

  async upsertAttachment(entry: ServerMetaAttachmentEntry): Promise<void> {
    this.attachments.set(entry.attachmentId, entry);
  }

  async removeAttachment(attachmentId: string): Promise<void> {
    this.attachments.delete(attachmentId);
  }
}

const remote: RemoteDocumentWithContent = {
  id: "doc1",
  workspaceId: "ws1",
  folderId: "folder1",
  title: "Runbook",
  path: "/engineering/runbook",
  permission: "editor",
  version: "rev1",
  checksum: "sha256:old",
  content: "# Runbook\r\n",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

describe("plugin sync", () => {
  it("maps remote paths into the configured local folder", () => {
    expect(localPathForRemote("Remote Docs", "/engineering/runbook")).toBe("Remote Docs/engineering/runbook.md");
    expect(localPathForRemote("Remote Docs", "root.md")).toBe("Remote Docs/root.md");
  });

  it("extracts markdown and Obsidian image attachment references", () => {
    expect(
      [...extractAttachmentPaths("![one](img/a.png)\n[download](files/report.pdf)\n![[b.jpg|thumb]]\n[doc](other.md)\n![remote](https://x.test/a.png)", "Remote Docs/e2e/doc.md")],
    ).toEqual(["Remote Docs/e2e/img/a.png", "Remote Docs/e2e/files/report.pdf", "Remote Docs/e2e/b.jpg"]);
  });

  it("syncs attachments by downloading remote files, uploading changed local references, and deleting missing tracked files", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    const entry: ServerMetaEntry = { documentId: "doc1", localPath: "Remote Docs/e2e/doc.md", remotePath: "/e2e/doc", title: "Doc", baseVersion: "rev1", checksum: "sha256:doc", permission: "editor", updatedAt: "old" };
    await meta.upsert(entry);
    await meta.upsertAttachment({ attachmentId: "old", documentId: "doc1", localPath: "Remote Docs/e2e/old.png", filename: "old.png", sha256: "oldsha", size: 1, contentType: "image/png", createdAt: "old" });
    const oldAttachment: Attachment = { id: "old", filename: "old.png", contentType: "image/png", size: 1, sha256: "oldsha", createdAt: "old" };
    const remoteAttachment: Attachment = { id: "remote", filename: "server.png", contentType: "image/png", size: 4, sha256: "remotesha", createdAt: "new" };
    const uploaded: Attachment = { id: "uploaded", filename: "local.png", contentType: "image/png", size: 5, sha256: "uploadsha", createdAt: "later" };
    await vault.write("Remote Docs/e2e/doc.md", "![local](local.png)\n");
    await vault.writeBinary("Remote Docs/e2e/local.png", new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const api = {
      document: vi.fn(),
      push: vi.fn(),
      attachments: vi.fn().mockResolvedValue({ attachments: [oldAttachment, remoteAttachment] }),
      downloadAttachment: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9, 9]).buffer),
      uploadAttachment: vi.fn().mockResolvedValue(uploaded),
      deleteAttachment: vi.fn().mockResolvedValue(undefined),
    };

    const result = await syncDocumentAttachments({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, entry, "![local](local.png)\n");

    expect(result).toMatchObject({ downloaded: 1, uploaded: 1, deleted: 1 });
    expect(vault.binaryFiles.has("Remote Docs/e2e/server.png")).toBe(true);
    expect(api.uploadAttachment).toHaveBeenCalledWith("doc1", "local.png", expect.any(ArrayBuffer), "image/png");
    expect(api.deleteAttachment).toHaveBeenCalledWith("old");
    expect(await meta.listAttachmentsForDocument("doc1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attachmentId: "remote", localPath: "Remote Docs/e2e/server.png" }),
        expect.objectContaining({ attachmentId: "uploaded", localPath: "Remote Docs/e2e/local.png" }),
      ]),
    );
  });

  it("downloads a document, creates folders, canonicalizes content, and updates metadata", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    const api = { document: vi.fn().mockResolvedValue(remote), push: vi.fn() };

    const result = await downloadDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, remote);

    expect(result.localPath).toBe("Remote Docs/engineering/runbook.md");
    expect(vault.folders.has("Remote Docs")).toBe(true);
    expect(vault.folders.has("Remote Docs/engineering")).toBe(true);
    expect(vault.files.get(result.localPath)).toBe("# Runbook\n");
    expect(await meta.getByLocalPath(result.localPath)).toMatchObject({ documentId: "doc1", baseVersion: "rev1" });
  });

  it("pushes an editor document with baseVersion and advances metadata", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await meta.upsert({ documentId: "doc1", localPath: "Remote Docs/runbook.md", remotePath: "/runbook", title: "Runbook", baseVersion: "rev1", checksum: "sha256:old", permission: "editor", updatedAt: "old" });
    await vault.write("Remote Docs/runbook.md", "# Local\r\n");
    const api = {
      document: vi.fn(),
      push: vi.fn().mockResolvedValue({ id: "doc1", version: "rev2", checksum: "sha256:new", updatedAt: "new" }),
    };

    const result = await pushLocalDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, "Remote Docs/runbook.md");

    expect(result.status).toBe("pushed");
    expect(api.push).toHaveBeenCalledWith("doc1", expect.objectContaining({ baseVersion: "rev1", content: "# Local\n" }));
    expect(await meta.getByLocalPath("Remote Docs/runbook.md")).toMatchObject({ baseVersion: "rev2", checksum: "sha256:new" });
  });

  it("creates a remote document for an unlinked local note and stores sync metadata", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/imported-from-web/hermes-deployment/ooo.md", "---\ntitle: OOO\n---\n\nTest\r\n");
    const createdRemote: RemoteDocumentWithContent = {
      id: "doc-new",
      workspaceId: "ws1",
      folderId: "folder-hermes",
      title: "OOO",
      path: "imported-from-web/hermes-deployment/ooo.md",
      permission: "editor",
      version: "rev-new",
      checksum: "sha256:new",
      content: "---\ntitle: OOO\n---\n\nTest\n",
      updatedAt: "2026-06-14T00:00:00.000Z",
    };
    const api = {
      tree: vi.fn().mockResolvedValue({ folders: [], documents: [] }),
      createFolder: vi
        .fn()
        .mockResolvedValueOnce({ id: "folder-imported", path: "imported-from-web" })
        .mockResolvedValueOnce({ id: "folder-hermes", path: "imported-from-web/hermes-deployment" }),
      createDocument: vi.fn().mockResolvedValue({ id: "doc-new", version: "rev-new", checksum: "sha256:new", path: "imported-from-web/hermes-deployment/ooo.md" }),
      document: vi.fn().mockResolvedValue(createdRemote),
      push: vi.fn(),
    };

    const result = await pushOrCreateLocalDocument(
      { api, vault, meta, remoteDocsFolder: "Remote Docs", workspaceId: "ws1" },
      "Remote Docs/imported-from-web/hermes-deployment/ooo.md",
    );

    expect(result.status).toBe("created");
    expect(api.createFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ parentFolderId: null, slug: "imported-from-web" }));
    expect(api.createFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ parentFolderId: "folder-imported", slug: "hermes-deployment" }));
    expect(api.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: "folder-hermes",
        title: "OOO",
        slug: "ooo",
        content: "---\ntitle: OOO\n---\n\nTest\n",
      }),
    );
    expect(await meta.getByLocalPath("Remote Docs/imported-from-web/hermes-deployment/ooo.md")).toMatchObject({
      documentId: "doc-new",
      remotePath: "imported-from-web/hermes-deployment/ooo.md",
      baseVersion: "rev-new",
    });
  });

  it("does not create over an existing remote path for an unlinked local note", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/team/plan.md", "# Local\n");
    const api = {
      tree: vi.fn().mockResolvedValue({
        folders: [{ id: "folder-team", parentFolderId: null, name: "Team", slug: "team", path: "team", permission: "manager" }],
        documents: [{ id: "doc-existing", folderId: "folder-team", title: "Plan", path: "team/plan.md", permission: "editor", version: "rev1", checksum: "sha256:x" }],
      }),
      createFolder: vi.fn(),
      createDocument: vi.fn(),
      document: vi.fn(),
      push: vi.fn(),
    };

    await expect(
      createRemoteDocumentFromLocal({ api, vault, meta, remoteDocsFolder: "Remote Docs", workspaceId: "ws1" }, "Remote Docs/team/plan.md"),
    ).rejects.toThrow(/already exists/);
    expect(api.createDocument).not.toHaveBeenCalled();
  });

  it("blocks viewer-only pushes before calling the API", async () => {
    const meta = new MemoryMeta();
    await meta.upsert({ documentId: "doc1", localPath: "Remote Docs/runbook.md", remotePath: "/runbook", title: "Runbook", baseVersion: "rev1", checksum: "sha256:old", permission: "viewer", updatedAt: "old" });
    const api = { document: vi.fn(), push: vi.fn() };

    const result = await pushLocalDocument({ api, vault: new MemoryVault(), meta, remoteDocsFolder: "Remote Docs" }, "Remote Docs/runbook.md");

    expect(result.status).toBe("blocked_viewer");
    expect(api.push).not.toHaveBeenCalled();
  });

  it("keeps local edits and writes a conflict copy of the server version on 409", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await meta.upsert({ documentId: "doc1", localPath: "Remote Docs/runbook.md", remotePath: "/runbook", title: "Runbook", baseVersion: "rev1", checksum: "sha256:old", permission: "editor", updatedAt: "old" });
    await vault.write("Remote Docs/runbook.md", "# Local\n");
    const api = {
      push: vi.fn().mockRejectedValue(new PagedenApiError(409, { error: "conflict", currentVersion: "rev2" })),
      document: vi.fn().mockResolvedValue({ ...remote, content: "# Server\n", version: "rev2", checksum: "sha256:server" }),
    };

    const result = await pushLocalDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, "Remote Docs/runbook.md");

    expect(result.status).toBe("conflict");
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Local\n");
    expect(vault.files.get("Remote Docs/runbook.conflict.md")).toBe("# Server\n");
    expect(await meta.getByLocalPath("Remote Docs/runbook.md")).toMatchObject({ baseVersion: "rev2", checksum: "sha256:server" });
  });
});

describe("background sync", () => {
  const entry = (over: Partial<ServerMetaEntry> = {}): ServerMetaEntry => ({
    documentId: "doc1",
    localPath: "Remote Docs/runbook.md",
    remotePath: "/runbook",
    title: "Runbook",
    baseVersion: "rev1",
    checksum: "sha256:tracked",
    permission: "editor",
    updatedAt: "old",
    ...over,
  });

  it("is a no-op when the server version matches and local has not diverged", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Same\n");
    const e = entry({ checksum: await checksum("# Same\n") });
    await meta.upsert(e);
    const api = { document: vi.fn().mockResolvedValue({ ...remote, version: "rev1", content: "# Same\n" }), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("unchanged");
    expect(api.push).not.toHaveBeenCalled();
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Same\n");
  });

  it("pulls server content (canonicalizing CRLF) and advances meta when the server moved", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Same\n");
    const e = entry({ checksum: await checksum("# Same\n") });
    await meta.upsert(e);
    const api = {
      document: vi.fn().mockResolvedValue({ ...remote, version: "rev2", checksum: "sha256:server2", content: "# Server v2\r\n" }),
      push: vi.fn(),
    };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("pulled");
    expect(api.push).not.toHaveBeenCalled();
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Server v2\n"); // CRLF canonicalized
    expect(await meta.getByLocalPath("Remote Docs/runbook.md")).toMatchObject({ baseVersion: "rev2", checksum: "sha256:server2" });
  });

  it("pushes local edits when local diverged and the server has not moved", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Local edit\n");
    const e = entry({ checksum: "sha256:tracked" }); // tracked != checksum of local → diverged
    await meta.upsert(e);
    const api = {
      document: vi.fn().mockResolvedValue({ ...remote, version: "rev1" }), // server unchanged
      push: vi.fn().mockResolvedValue({ id: "doc1", version: "rev2", checksum: "sha256:new", updatedAt: "new" }),
    };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("pushed");
    expect(api.push).toHaveBeenCalledWith("doc1", expect.objectContaining({ baseVersion: "rev1", content: "# Local edit\n" }));
  });

  it("writes a conflict copy and preserves local when the server moved AND local diverged", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Local edit\n");
    const e = entry({ checksum: "sha256:tracked" });
    await meta.upsert(e);
    const api = {
      document: vi.fn().mockResolvedValue({ ...remote, version: "rev2", checksum: "sha256:server", content: "# Server\n" }),
      push: vi.fn().mockRejectedValue(new PagedenApiError(409, { error: "conflict", currentVersion: "rev2" })),
    };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("conflict");
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Local edit\n"); // never clobbered
    expect(vault.files.get("Remote Docs/runbook.conflict.md")).toBe("# Server\n");
  });

  it("reports a 404 document as gone and leaves the local file untouched", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Same\n");
    const e = entry({ checksum: await checksum("# Same\n") });
    await meta.upsert(e);
    const api = { document: vi.fn().mockRejectedValue(new PagedenApiError(404, { error: "not_found" })), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("gone");
    expect(api.push).not.toHaveBeenCalled();
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Same\n");
  });

  it("does NOT auto-push while an unresolved conflict copy exists (sticky conflict)", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Local edit\n");
    await vault.write("Remote Docs/runbook.conflict.md", "# Server side\n"); // unresolved conflict
    const e = entry({ checksum: "sha256:tracked" }); // local diverged
    await meta.upsert(e);
    const api = { document: vi.fn().mockResolvedValue({ ...remote, version: "rev2" }), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("conflict_pending");
    expect(api.push).not.toHaveBeenCalled();
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Local edit\n");
  });

  it("does not clobber a local edit that lands between the divergence check and the write (TOCTOU)", async () => {
    class RaceVault extends MemoryVault {
      reads = 0;
      async read(path: string): Promise<string> {
        this.reads += 1;
        // 1st read (divergence check): matches tracked. 2nd read (pre-write guard): user just edited.
        return this.reads === 1 ? "# Same\n" : "# Edited mid-flight\n";
      }
    }
    const vault = new RaceVault();
    await vault.write("Remote Docs/runbook.md", "# Same\n");
    const meta = new MemoryMeta();
    const e = entry({ checksum: await checksum("# Same\n") });
    await meta.upsert(e);
    const api = { document: vi.fn().mockResolvedValue({ ...remote, version: "rev2", checksum: "sha256:server2", content: "# Server v2\n" }), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("conflict");
    expect(api.push).not.toHaveBeenCalled();
    expect(vault.files.get("Remote Docs/runbook.conflict.md")).toBe("# Server v2\n");
    // original local file was not overwritten by the pull
    expect(vault.files.get("Remote Docs/runbook.md")).toBe("# Same\n");
  });

  it("does not push when the server has downgraded the document to viewer", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/runbook.md", "# Local edit\n");
    const e = entry({ checksum: "sha256:tracked", permission: "editor" }); // diverged, meta says editor
    await meta.upsert(e);
    const api = { document: vi.fn().mockResolvedValue({ ...remote, version: "rev1", permission: "viewer" }), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("blocked_viewer");
    expect(api.push).not.toHaveBeenCalled();
    expect(await meta.getByLocalPath("Remote Docs/runbook.md")).toMatchObject({ permission: "viewer" });
  });

  it("does not resurrect a tracked file the user deleted locally", async () => {
    const vault = new MemoryVault(); // file absent
    const meta = new MemoryMeta();
    const e = entry({ checksum: "sha256:tracked" });
    await meta.upsert(e);
    const api = { document: vi.fn().mockResolvedValue({ ...remote, version: "rev2", content: "# Server\n" }), push: vi.fn() };

    const result = await syncLinkedDocument({ api, vault, meta, remoteDocsFolder: "Remote Docs" }, e);

    expect(result.status).toBe("missing_local");
    expect(vault.files.has("Remote Docs/runbook.md")).toBe(false);
    expect(api.push).not.toHaveBeenCalled();
  });

  it("runBackgroundSyncPass tallies results and isolates per-document errors", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/a.md", "# A\n");
    await meta.upsert(entry({ documentId: "docA", localPath: "Remote Docs/a.md", checksum: await checksum("# A\n") }));
    await meta.upsert(entry({ documentId: "docB", localPath: "Remote Docs/b.md", checksum: await checksum("# B\n") }));
    const api = {
      document: vi.fn().mockImplementation((id: string) => {
        if (id === "docA") return Promise.resolve({ ...remote, id: "docA", version: "rev1", content: "# A\n" });
        return Promise.reject(new PagedenApiError(500, { error: "server_error" }));
      }),
      push: vi.fn(),
    };

    const summary = await runBackgroundSyncPass({ api, vault, meta, remoteDocsFolder: "Remote Docs" });

    expect(summary.unchanged).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it("runBackgroundSyncPass creates unlinked local notes under the remote docs folder", async () => {
    const vault = new MemoryVault();
    const meta = new MemoryMeta();
    await vault.write("Remote Docs/team/new-plan.md", "# New plan\n");
    const createdRemote: RemoteDocumentWithContent = {
      id: "doc-new",
      workspaceId: "ws1",
      folderId: "folder-team",
      title: "New Plan",
      path: "team/new-plan.md",
      permission: "editor",
      version: "rev-new",
      checksum: "sha256:new",
      content: "# New plan\n",
      updatedAt: "2026-06-14T00:00:00.000Z",
    };
    const api = {
      document: vi.fn().mockResolvedValue(createdRemote),
      push: vi.fn(),
      tree: vi.fn().mockResolvedValue({
        folders: [{ id: "folder-team", parentFolderId: null, name: "Team", slug: "team", path: "team", permission: "manager" }],
        documents: [],
      }),
      createFolder: vi.fn(),
      createDocument: vi.fn().mockResolvedValue({ id: "doc-new", version: "rev-new", checksum: "sha256:new", path: "team/new-plan.md" }),
    };

    const summary = await runBackgroundSyncPass({
      api,
      vault,
      meta,
      remoteDocsFolder: "Remote Docs",
      workspaceId: "ws1",
      localMarkdownPaths: async () => ["Remote Docs/team/new-plan.md"],
    });

    expect(summary.created).toBe(1);
    expect(summary.errors).toBe(0);
    expect(api.createDocument).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-team", slug: "new-plan" }));
    expect(await meta.getByLocalPath("Remote Docs/team/new-plan.md")).toMatchObject({ documentId: "doc-new", baseVersion: "rev-new" });
  });
});
