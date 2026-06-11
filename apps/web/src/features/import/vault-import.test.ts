import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildImportReportMarkdown, buildWebImportPreview, extractAttachmentRefs, filesFromFileList, importFilesToWorkspace, slugify } from "./vault-import";

const apiMock = vi.hoisted(() => ({
  createFolder: vi.fn(),
  createDocument: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: apiMock,
}));

function vaultFile(path: string, content: string, type = "text/plain"): File {
  const file = new File([content], path.split("/").pop() ?? path, { type });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

const emptyTree = {
  folders: [],
  documents: [],
};

describe("web vault import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes browser folder files and previews import counts", async () => {
    const files = filesFromFileList([
      vaultFile("My Vault/Runbook.md", "---\ntitle: Runbook\n---\nHello"),
      vaultFile("My Vault/assets/diagram.png", "png", "image/png"),
      vaultFile("My Vault/.obsidian/app.json", "{}"),
      vaultFile("My Vault/Draft.conflict.md", "conflict"),
    ]);

    const preview = await buildWebImportPreview(files, emptyTree, "Imported Notes");

    expect(files.map((file) => file.path)).toEqual([
      "Runbook.md",
      "assets/diagram.png",
      ".obsidian/app.json",
      "Draft.conflict.md",
    ]);
    expect(files.map((file) => file.originalPath)).toEqual([
      "My Vault/Runbook.md",
      "My Vault/assets/diagram.png",
      "My Vault/.obsidian/app.json",
      "My Vault/Draft.conflict.md",
    ]);
    expect(preview).toMatchObject({
      targetRootSlug: "imported-notes",
      notes: 1,
      attachments: 1,
      skipped: 2,
      frontmatter: 1,
      conflicts: [],
      samplePaths: ["Runbook.md"],
    });
  });

  it("reports conflicts against existing remote document paths", async () => {
    const preview = await buildWebImportPreview(
      filesFromFileList([vaultFile("Vault/Team/Run Book.md", "Hello")]),
      {
        folders: [],
        documents: [
          {
            id: "doc1",
            folderId: "folder1",
            title: "Run Book",
            path: "imported/team/run-book.md",
            permission: "editor",
            version: "rev1",
            checksum: "sha256:x",
            updatedAt: "2026-06-10T00:00:00.000Z",
          },
        ],
      },
      "Imported",
    );

    expect(preview.conflicts).toEqual(["imported/team/run-book.md"]);
  });

  it("warns when attachment references are missing or ambiguous", async () => {
    const preview = await buildWebImportPreview(
      filesFromFileList([
        vaultFile("Vault/Team/Run Book.md", "![[missing.png]]\n![[logo.png]]"),
        vaultFile("Vault/assets/logo.png", "one", "image/png"),
        vaultFile("Vault/other/logo.png", "two", "image/png"),
      ]),
      emptyTree,
      "Imported",
    );

    expect(preview.attachmentWarnings).toEqual([
      'Team/Run Book.md references "logo.png", but multiple selected files share that name (assets/logo.png, other/logo.png). Pageden will not guess which one to attach.',
      'Team/Run Book.md references "missing.png", but that file was not selected. The note will import, but that media link may be broken.',
    ]);
  });

  it("can import a conflicting note as a renamed duplicate", async () => {
    apiMock.createDocument.mockResolvedValue({
      id: "doc2",
      path: "imported/team/run-book-2.md",
      version: "rev2",
      checksum: "sha256:y",
      updatedAt: "2026-06-10T00:00:00.000Z",
    });
    const files = filesFromFileList([vaultFile("Vault/Team/Run Book.md", "Hello")]);
    const report = await importFilesToWorkspace({
      workspaceId: "ws1",
      files,
      targetRootName: "Imported",
      conflictPolicy: "rename",
      tree: {
        folders: [
          { id: "root", parentFolderId: null, name: "Imported", slug: "imported", path: "imported", permission: "manager" },
          { id: "team", parentFolderId: "root", name: "Team", slug: "team", path: "imported/team", permission: "manager" },
        ],
        documents: [
          {
            id: "doc1",
            folderId: "team",
            title: "Run Book",
            path: "imported/team/run-book.md",
            permission: "editor",
            version: "rev1",
            checksum: "sha256:x",
            updatedAt: "2026-06-10T00:00:00.000Z",
          },
        ],
      },
    });

    expect(apiMock.createDocument).toHaveBeenCalledWith(expect.objectContaining({ folderId: "team", slug: "run-book-2" }));
    expect(report.documentsCreated).toBe(1);
    expect(report.documentsSkipped).toBe(0);
    expect(report.rows[0]).toMatchObject({ status: "created", message: "Created duplicate as imported/team/run-book-2.md" });
  });

  it("finds Obsidian and Markdown attachment references", () => {
    expect(extractAttachmentRefs("![[diagram.png|Diagram]]\n![Alt](assets/photo%201.jpg)\n![Remote](https://x.test/a.png)")).toEqual([
      "diagram.png",
      "assets/photo 1.jpg",
    ]);
  });

  it("creates stable slugs", () => {
    expect(slugify("Résumé Runbook.md")).toBe("resume-runbook");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("builds a downloadable Markdown report", () => {
    const markdown = buildImportReportMarkdown({
      targetRootName: "Imported",
      targetRootSlug: "imported",
      notes: 2,
      attachments: 1,
      skipped: 1,
      frontmatter: 1,
      conflicts: ["imported/team/run-book.md"],
      attachmentWarnings: ["Team/Run Book.md references missing.png."],
      samplePaths: ["Team/Run Book.md"],
      foldersCreated: 1,
      documentsCreated: 1,
      documentsSkipped: 1,
      attachmentsUploaded: 0,
      rows: [
        { path: "Team/Run Book.md", status: "skipped", message: "A document with this path already exists." },
        { path: "Team/New.md", status: "created", message: "Created imported/team/new.md" },
      ],
    });

    expect(markdown).toContain("# Pageden Import Report");
    expect(markdown).toContain("- Documents skipped: 1");
    expect(markdown).toContain("## Existing Documents");
    expect(markdown).toContain("| Team/New.md | created | Created imported/team/new.md |");
  });
});
