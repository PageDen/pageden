import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildVaultImportPreview, extractAttachmentRefs, importVaultToPageden, slugify, type VaultImportFile } from "./import-vault";
import type { RemoteDocumentWithContent, RemoteTree, ServerMetaEntry } from "./types";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const files: VaultImportFile[] = [
  { path: "Projects/Launch.md", name: "Launch.md", extension: "md" },
  { path: "Projects/assets/diagram.png", name: "diagram.png", extension: "png" },
  { path: ".obsidian/app.json", name: "app.json", extension: "json" },
  { path: "Scratch.conflict.md", name: "Scratch.conflict.md", extension: "md" },
];

const emptyTree: RemoteTree = { folders: [], documents: [] };

describe("vault import", () => {
  it("previews notes, attachments, skipped internal files, and remote path conflicts", () => {
    const preview = buildVaultImportPreview(files, {
      folders: [],
      documents: [
        {
          id: "doc-existing",
          folderId: "folder-existing",
          title: "Launch",
          path: "imported-from-obsidian/projects/launch.md",
          permission: "editor",
          version: "rev1",
          checksum: "sha256:x",
        },
      ],
    });

    expect(preview).toMatchObject({
      targetRootSlug: "imported-from-obsidian",
      notes: 1,
      attachments: 1,
      skipped: 2,
      conflicts: ["imported-from-obsidian/projects/launch.md"],
    });
  });

  it("extracts Obsidian and Markdown attachment embeds", () => {
    expect(extractAttachmentRefs("![[diagram.png|wide]]\n![chart](assets/chart%201.png)\n![remote](https://example.com/x.png)")).toEqual([
      "diagram.png",
      "assets/chart 1.png",
    ]);
  });

  it("slugifies names into stable URL-safe segments", () => {
    expect(slugify("Finance Plan.md")).toBe("finance-plan");
    expect(slugify("你好")).toBe("untitled");
  });

  it("creates folders and documents, links metadata, and uploads referenced attachments", async () => {
    const read = vi.fn(async (path: string) => {
      if (path === "Projects/Launch.md") return "# Launch\r\n\n![[diagram.png]]\n";
      throw new Error(`missing ${path}`);
    });
    const readBinary = vi.fn(async (path: string) => {
      if (path === "Projects/assets/diagram.png") return new Uint8Array([1, 2, 3]).buffer;
      throw new Error(`missing binary ${path}`);
    });
    const upsert = vi.fn();
    const remoteDoc: RemoteDocumentWithContent = {
      id: "doc1",
      workspaceId: "ws1",
      folderId: "folder-projects",
      title: "Launch",
      path: "imported-from-obsidian/projects/launch.md",
      permission: "editor",
      version: "rev1",
      checksum: "sha256:server",
      content: "# Launch\n\n![[diagram.png]]\n",
      updatedAt: "2026-06-10T00:00:00.000Z",
    };
    const api = {
      tree: vi.fn(async () => emptyTree),
      createFolder: vi
        .fn()
        .mockResolvedValueOnce({ id: "folder-root", path: "imported-from-obsidian" })
        .mockResolvedValueOnce({ id: "folder-projects", path: "imported-from-obsidian/projects" }),
      createDocument: vi.fn(async () => ({ id: "doc1", version: "rev1", checksum: "sha256:server", path: "imported-from-obsidian/projects/launch.md" })),
      document: vi.fn(async () => remoteDoc),
      uploadAttachment: vi.fn(async () => ({ id: "att1", filename: "diagram.png", contentType: "image/png", size: 3, sha256: "sha256:a", createdAt: "now" })),
    };

    const report = await importVaultToPageden({
      api,
      vault: { read, readBinary },
      meta: { upsert },
      workspaceId: "ws1",
      files,
      targetRootName: "Imported from Obsidian",
      remoteTree: emptyTree,
    });

    expect(report).toMatchObject({ foldersCreated: 2, documentsCreated: 1, documentsSkipped: 0, attachmentsUploaded: 1 });
    expect(api.createFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ parentFolderId: null, slug: "imported-from-obsidian" }));
    expect(api.createFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ parentFolderId: "folder-root", slug: "projects" }));
    expect(api.createDocument).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-projects", title: "Launch", slug: "launch" }));
    expect(api.uploadAttachment).toHaveBeenCalledWith("doc1", "diagram.png", expect.any(ArrayBuffer), "image/png");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "doc1",
        localPath: "Projects/Launch.md",
        baseVersion: "rev1",
      } satisfies Partial<ServerMetaEntry>),
    );
  });
});
