import { normalizePath } from "obsidian";
import type { PagedenApiClient } from "./api-client";
import { canonicalize } from "./checksum";
import type { RemoteFolder, RemoteTree, ServerMetaEntry } from "./types";
import type { MetaStoreLike, VaultLike } from "./sync";

export interface VaultImportFile {
  path: string;
  name: string;
  extension: string;
}

export interface VaultImportPreview {
  targetRootName: string;
  targetRootSlug: string;
  notes: number;
  attachments: number;
  skipped: number;
  conflicts: string[];
  warnings: string[];
}

export interface VaultImportReport extends VaultImportPreview {
  foldersCreated: number;
  documentsCreated: number;
  documentsSkipped: number;
  attachmentsUploaded: number;
  attachmentWarnings: string[];
  rows: ImportReportRow[];
}

export type ImportReportRow =
  | { path: string; status: "created"; message: string }
  | { path: string; status: "skipped"; message: string }
  | { path: string; status: "warning"; message: string };

interface ImportDeps {
  api: Pick<PagedenApiClient, "tree" | "createFolder" | "createDocument" | "document" | "uploadAttachment">;
  vault: Pick<VaultLike, "read" | "readBinary">;
  meta: Pick<MetaStoreLike, "upsert">;
  workspaceId: string;
  files: VaultImportFile[];
  targetRootName: string;
  remoteTree?: RemoteTree;
  onProgress?: (current: number, total: number) => void;
}

interface ImportableFiles {
  notes: VaultImportFile[];
  attachments: VaultImportFile[];
  skipped: number;
}

const DEFAULT_ROOT_NAME = "Imported from Obsidian";

export function buildVaultImportPreview(files: VaultImportFile[], remoteTree: RemoteTree, targetRootName = DEFAULT_ROOT_NAME): VaultImportPreview {
  const importable = splitImportableFiles(files);
  const targetRootSlug = slugify(targetRootName);
  const remoteDocumentPaths = new Set(remoteTree.documents.map((doc) => trimSlashes(doc.path)));
  const conflicts = importable.notes
    .map((file) => remotePathForNote(file.path, targetRootSlug))
    .filter((path) => remoteDocumentPaths.has(path))
    .sort();

  const warnings = conflicts.length
    ? [`${conflicts.length} note${conflicts.length === 1 ? "" : "s"} already exist in Pageden and will be skipped.`]
    : [];

  return {
    targetRootName,
    targetRootSlug,
    notes: importable.notes.length,
    attachments: importable.attachments.length,
    skipped: importable.skipped,
    conflicts,
    warnings,
  };
}

export async function importVaultToPageden(deps: ImportDeps): Promise<VaultImportReport> {
  const remoteTree = deps.remoteTree ?? (await deps.api.tree(deps.workspaceId));
  const preview = buildVaultImportPreview(deps.files, remoteTree, deps.targetRootName);
  const importable = splitImportableFiles(deps.files);
  const attachmentIndex = buildAttachmentIndex(importable.attachments);
  const folderByPath = new Map(remoteTree.folders.map((folder) => [trimSlashes(folder.path), folder]));
  const documentPaths = new Set(remoteTree.documents.map((doc) => trimSlashes(doc.path)));
  const targetRootSlug = preview.targetRootSlug;
  let foldersCreated = 0;
  let documentsCreated = 0;
  let documentsSkipped = 0;
  let attachmentsUploaded = 0;
  const attachmentWarnings: string[] = [];
  const rows: ImportReportRow[] = [];

  async function ensureRemoteFolder(localDir: string): Promise<RemoteFolder> {
    const segments = localDir.split("/").filter(Boolean);
    let parent: RemoteFolder | null = null;
    let currentPath = "";

    const rootPath = targetRootSlug;
    parent = folderByPath.get(rootPath) ?? null;
    if (!parent) {
      const created = await deps.api.createFolder({
        workspaceId: deps.workspaceId,
        parentFolderId: null,
        name: deps.targetRootName,
        slug: targetRootSlug,
      });
      parent = folderFromCreate(created.id, null, deps.targetRootName, targetRootSlug, created.path);
      folderByPath.set(rootPath, parent);
      foldersCreated += 1;
    }
    currentPath = rootPath;

    for (const segment of segments) {
      const slug = slugify(segment);
      currentPath = `${currentPath}/${slug}`;
      const existing = folderByPath.get(currentPath);
      if (existing) {
        parent = existing;
        continue;
      }
      const created = await deps.api.createFolder({
        workspaceId: deps.workspaceId,
        parentFolderId: parent.id,
        name: segment,
        slug,
      });
      parent = folderFromCreate(created.id, parent.id, segment, slug, created.path);
      folderByPath.set(currentPath, parent);
      foldersCreated += 1;
    }

    return parent;
  }

  let noteIndex = 0;
  for (const note of importable.notes) {
    noteIndex++;
    deps.onProgress?.(noteIndex, importable.notes.length);
    const remotePath = remotePathForNote(note.path, targetRootSlug);
    if (documentPaths.has(remotePath)) {
      documentsSkipped += 1;
      rows.push({ path: note.path, status: "skipped", message: "A document with this path already exists." });
      continue;
    }
    const localDir = dirname(note.path);
    const folder = await ensureRemoteFolder(localDir);
    const content = canonicalize(await deps.vault.read(note.path));
    const title = frontmatterTitle(content) ?? (basename(note.path).replace(/\.md$/i, "") || "Untitled");
    const created = await deps.api.createDocument({
      workspaceId: deps.workspaceId,
      folderId: folder.id,
      title,
      slug: slugify(basename(note.path).replace(/\.md$/i, "")),
      content,
    });
    documentPaths.add(trimSlashes(created.path));
    const remote = await deps.api.document(created.id);
    await deps.meta.upsert(metaFromImportedRemote(remote, note.path));
    documentsCreated += 1;
    rows.push({ path: note.path, status: "created", message: `Created ${created.path}` });

    const refs = extractAttachmentRefs(content);
    const uploadedForDoc = new Set<string>();
    for (const ref of refs) {
      const attachment = resolveAttachmentRef(ref, note.path, attachmentIndex);
      if (!attachment || uploadedForDoc.has(attachment.path)) continue;
      uploadedForDoc.add(attachment.path);
      if (!deps.vault.readBinary) {
        const message = `Cannot upload ${attachment.path}: this vault adapter does not support binary reads.`;
        attachmentWarnings.push(message);
        rows.push({ path: attachment.path, status: "warning", message });
        continue;
      }
      try {
        const bytes = await deps.vault.readBinary(attachment.path);
        await uploadAttachmentWithRetry(deps.api, remote.id, basename(attachment.path), bytes, mimeTypeForPath(attachment.path));
        attachmentsUploaded += 1;
      } catch (error) {
        const message = `Could not upload ${attachment.path}: ${error instanceof Error ? error.message : "unknown error"}`;
        attachmentWarnings.push(message);
        rows.push({ path: attachment.path, status: "warning", message });
      }
    }
  }

  return {
    ...preview,
    foldersCreated,
    documentsCreated,
    documentsSkipped,
    attachmentsUploaded,
    attachmentWarnings,
    rows,
  };
}

export function extractAttachmentRefs(markdown: string): string[] {
  const refs = new Set<string>();
  const obsidianEmbed = /!\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g;
  const markdownImage = /!\[[^\]]*]\((?![a-z][a-z0-9+.-]*:)([^)\s]+)(?:\s+"[^"]*")?\)/gi;

  for (const match of markdown.matchAll(obsidianEmbed)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of markdown.matchAll(markdownImage)) {
    if (match[1]) refs.add(decodeURIComponent(match[1]));
  }
  return [...refs];
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function splitImportableFiles(files: VaultImportFile[]): ImportableFiles {
  let skipped = 0;
  const notes: VaultImportFile[] = [];
  const attachments: VaultImportFile[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    if (isIgnoredPath(path)) {
      skipped += 1;
      continue;
    }
    if (file.extension.toLowerCase() === "md") {
      if (path.endsWith(".conflict.md")) skipped += 1;
      else notes.push({ ...file, path });
    } else {
      attachments.push({ ...file, path });
    }
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));
  attachments.sort((a, b) => a.path.localeCompare(b.path));
  return { notes, attachments, skipped };
}

function isIgnoredPath(path: string): boolean {
  return path.startsWith(".obsidian/") || path.startsWith(".trash/") || path.startsWith(".git/");
}

function buildAttachmentIndex(files: VaultImportFile[]) {
  const byPath = new Map<string, VaultImportFile>();
  const byName = new Map<string, VaultImportFile[]>();
  for (const file of files) {
    byPath.set(file.path, file);
    const list = byName.get(file.name) ?? [];
    list.push(file);
    byName.set(file.name, list);
  }
  return { byPath, byName };
}

function resolveAttachmentRef(
  ref: string,
  notePath: string,
  index: ReturnType<typeof buildAttachmentIndex>,
): VaultImportFile | null {
  const cleanRef = normalizePath(ref.replace(/^<|>$/g, ""));
  const noteDir = dirname(notePath);
  const candidates = [
    normalizePath(`${noteDir}/${cleanRef}`),
    cleanRef,
  ];
  for (const candidate of candidates) {
    const found = index.byPath.get(candidate);
    if (found) return found;
  }
  const byName = index.byName.get(basename(cleanRef));
  if (byName?.length) return byName[0] ?? null;
  return null;
}

function remotePathForNote(path: string, targetRootSlug: string): string {
  const localDir = dirname(path)
    .split("/")
    .filter(Boolean)
    .map(slugify)
    .join("/");
  const docSlug = slugify(basename(path));
  return [targetRootSlug, localDir, `${docSlug}.md`].filter(Boolean).join("/");
}

function frontmatterTitle(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  for (const line of raw.split("\n")) {
    const match = line.match(/^title:\s*(.+)$/i);
    if (!match?.[1]) continue;
    return match[1].trim().replace(/^['"]|['"]$/g, "") || null;
  }
  return null;
}

async function uploadAttachmentWithRetry(
  api: Pick<PagedenApiClient, "uploadAttachment">,
  documentId: string,
  name: string,
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  try {
    await api.uploadAttachment(documentId, name, bytes, mimeType);
  } catch (firstError) {
    try {
      await api.uploadAttachment(documentId, name, bytes, mimeType);
    } catch {
      throw firstError;
    }
  }
}

function folderFromCreate(id: string, parentFolderId: string | null, name: string, slug: string, path: string): RemoteFolder {
  return {
    id,
    parentFolderId,
    name,
    slug,
    path: trimSlashes(path),
    permission: "manager",
  };
}

function metaFromImportedRemote(remote: { id: string; path: string; title: string; version: string | null; checksum: string | null; permission: ServerMetaEntry["permission"]; updatedAt: string }, localPath: string): ServerMetaEntry {
  if (!remote.version || !remote.checksum) throw new Error("Imported document is missing version metadata.");
  return {
    documentId: remote.id,
    localPath,
    remotePath: remote.path,
    title: remote.title,
    baseVersion: remote.version,
    checksum: remote.checksum,
    permission: remote.permission,
    updatedAt: remote.updatedAt,
  };
}

function mimeTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() ?? "";
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
