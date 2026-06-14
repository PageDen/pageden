import { normalizePath } from "obsidian";
import type { PagedenApiClient } from "./api-client";
import { PagedenApiError } from "./api-client";
import { canonicalize, checksum } from "./checksum";
import type { Attachment, RemoteDocument, RemoteDocumentWithContent, RemoteFolder, RemoteTree, ServerMetaAttachmentEntry, ServerMetaEntry, WriteResult } from "./types";

export interface VaultLike {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary?(path: string, content: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export interface MetaStoreLike {
  list(): Promise<ServerMetaEntry[]>;
  getByLocalPath(path: string): Promise<ServerMetaEntry | null>;
  upsert(entry: ServerMetaEntry): Promise<void>;
  listAttachmentsForDocument?: (this: void, documentId: string) => Promise<ServerMetaAttachmentEntry[]>;
  upsertAttachment?: (this: void, entry: ServerMetaAttachmentEntry) => Promise<void>;
  removeAttachment?: (this: void, attachmentId: string) => Promise<void>;
}

export interface SyncDeps {
  api: Pick<PagedenApiClient, "getDocument" | "push"> &
    Partial<Pick<PagedenApiClient, "attachments" | "uploadAttachment" | "downloadAttachment" | "deleteAttachment">>;
  vault: VaultLike;
  meta: MetaStoreLike;
  remoteDocsFolder: string;
}

export interface CreateRemoteDeps extends SyncDeps {
  api: SyncDeps["api"] & Pick<PagedenApiClient, "tree" | "createFolder" | "createDocument">;
  workspaceId: string;
}

export interface BackgroundSyncDeps extends SyncDeps {
  api: SyncDeps["api"] & Partial<Pick<PagedenApiClient, "tree" | "createFolder" | "createDocument">>;
  workspaceId?: string;
  localMarkdownPaths?: () => Promise<string[]>;
}

export interface DownloadResult {
  localPath: string;
  meta: ServerMetaEntry;
  attachments: AttachmentSyncSummary;
}

export interface PushResult {
  status: "pushed" | "created" | "blocked_viewer" | "conflict";
  result?: WriteResult;
  conflictPath?: string;
  serverPath?: string;
  meta?: ServerMetaEntry;
}

export function localPathForRemote(remoteDocsFolder: string, remotePath: string): string {
  const withoutLeadingSlash = remotePath.replace(/^\/+/, "");
  const withExtension = withoutLeadingSlash.endsWith(".md") ? withoutLeadingSlash : `${withoutLeadingSlash}.md`;
  return normalizePath(`${remoteDocsFolder}/${withExtension}`);
}

export async function ensureFolder(vault: VaultLike, folderPath: string): Promise<void> {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.exists(current))) await vault.mkdir(current);
  }
}

export async function downloadDocument(deps: SyncDeps, doc: Pick<RemoteDocument, "id">): Promise<DownloadResult> {
  const remote = await deps.api.getDocument(doc.id);
  const localPath = localPathForRemote(deps.remoteDocsFolder, remote.path);
  const parent = localPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolder(deps.vault, parent);
  const content = canonicalize(remote.content);
  await deps.vault.write(localPath, content);
  const meta = metaFromRemote(remote, localPath);
  await deps.meta.upsert(meta);
  const attachments = hasAttachmentSupport(deps) ? await syncDocumentAttachments(deps, meta, content) : emptyAttachmentSummary();
  return { localPath, meta, attachments };
}

export async function pushLocalDocument(deps: SyncDeps, localPath: string): Promise<PushResult> {
  const meta = await deps.meta.getByLocalPath(localPath);
  if (!meta) throw new Error("This file is not linked to a Pageden document.");
  if (meta.permission === "viewer") return { status: "blocked_viewer" };

  const content = canonicalize(await deps.vault.read(localPath));
  try {
    const result = await deps.api.push(meta.documentId, {
      baseVersion: meta.baseVersion,
      checksum: await checksum(content),
      content,
    });
    const nextMeta = { ...meta, baseVersion: result.version, checksum: result.checksum, updatedAt: result.updatedAt };
    await deps.meta.upsert(nextMeta);
    if (hasAttachmentSupport(deps)) await syncDocumentAttachments(deps, nextMeta, content);
    return { status: "pushed", result };
  } catch (error) {
    if (error instanceof PagedenApiError && error.status === 409) {
      const server = await deps.api.getDocument(meta.documentId);
      const conflictPath = await writeConflictFile(deps.vault, localPath, server);
      await deps.meta.upsert({ ...meta, baseVersion: server.version ?? meta.baseVersion, checksum: server.checksum ?? meta.checksum, permission: server.permission, updatedAt: server.updatedAt });
      return { status: "conflict", conflictPath, serverPath: server.path };
    }
    throw error;
  }
}

export async function pushOrCreateLocalDocument(deps: CreateRemoteDeps, localPath: string): Promise<PushResult> {
  const meta = await deps.meta.getByLocalPath(localPath);
  if (meta) return pushLocalDocument(deps, localPath);
  return createRemoteDocumentFromLocal(deps, localPath);
}

export async function createRemoteDocumentFromLocal(deps: CreateRemoteDeps, localPath: string): Promise<PushResult> {
  const content = canonicalize(await deps.vault.read(localPath));
  const tree = await deps.api.tree(deps.workspaceId);
  const target = targetPathForLocal(deps.remoteDocsFolder, localPath);
  const existingPath = target.documentPath;
  if (tree.documents.some((doc) => trimSlashes(doc.path) === existingPath)) {
    throw new Error(`A Pageden document already exists at "${existingPath}". Download it first to link this local note safely.`);
  }

  const folder = await ensureRemoteFolderPath(deps.api, deps.workspaceId, tree, target.folderSegments);
  const created = await deps.api.createDocument({
    workspaceId: deps.workspaceId,
    folderId: folder.id,
    title: frontmatterTitle(content) ?? target.title,
    slug: target.documentSlug,
    content,
  });
  const remote = await deps.api.getDocument(created.id);
  const meta = metaFromRemote(remote, localPath);
  await deps.meta.upsert(meta);
  if (hasAttachmentSupport(deps)) await syncDocumentAttachments(deps, meta, content);
  return {
    status: "created",
    result: { id: remote.id, version: meta.baseVersion, checksum: meta.checksum, updatedAt: meta.updatedAt },
    meta,
  };
}

async function writeConflictFile(vault: VaultLike, localPath: string, server: RemoteDocumentWithContent): Promise<string> {
  const stem = localPath.replace(/\.md$/i, "");
  const conflictPath = normalizePath(`${stem}.conflict.md`);
  await vault.write(conflictPath, canonicalize(server.content));
  return conflictPath;
}

function metaFromRemote(remote: RemoteDocumentWithContent, localPath: string): ServerMetaEntry {
  if (!remote.version || !remote.checksum) {
    throw new Error("Remote document is missing version metadata.");
  }
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

async function ensureRemoteFolderPath(
  api: Pick<PagedenApiClient, "createFolder">,
  workspaceId: string,
  tree: RemoteTree,
  folderSegments: string[],
): Promise<RemoteFolder> {
  const folderByPath = new Map(tree.folders.map((folder) => [trimSlashes(folder.path), folder]));
  let parent: RemoteFolder | null = null;
  let currentPath = "";

  for (const segment of folderSegments) {
    const slug = slugify(segment);
    currentPath = currentPath ? `${currentPath}/${slug}` : slug;
    const existing = folderByPath.get(currentPath);
    if (existing) {
      parent = existing;
      continue;
    }
    const created = await api.createFolder({
      workspaceId,
      parentFolderId: parent?.id ?? null,
      name: segment,
      slug,
    });
    parent = {
      id: created.id,
      parentFolderId: parent?.id ?? null,
      name: segment,
      slug,
      path: trimSlashes(created.path),
      permission: "manager",
    };
    folderByPath.set(currentPath, parent);
  }

  if (!parent) {
    throw new Error("Create the note inside a folder so Pageden knows where to place it.");
  }
  return parent;
}

function targetPathForLocal(remoteDocsFolder: string, localPath: string) {
  const normalizedLocal = normalizePath(localPath);
  const normalizedRoot = normalizePath(remoteDocsFolder).replace(/\/+$/, "");
  const relativePath = normalizedLocal === normalizedRoot
    ? ""
    : normalizedLocal.startsWith(`${normalizedRoot}/`)
      ? normalizedLocal.slice(normalizedRoot.length + 1)
      : normalizedLocal;
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop() ?? "untitled.md";
  const folderSegments = parts.map((part) => part.replace(/\.md$/i, ""));
  const title = filename.replace(/\.md$/i, "") || "Untitled";
  const documentSlug = slugify(filename);
  const documentPath = [...folderSegments.map(slugify), `${documentSlug}.md`].filter(Boolean).join("/");
  return { folderSegments, title, documentSlug, documentPath };
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

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}


// ---------------------------------------------------------------------------
// Background sync (Milestone 6). Pure orchestration over the same primitives the manual
// commands use, so behaviour (canonicalization, opaque version, 409 → *.conflict.md, never
// overwrite local) stays identical. The Obsidian-facing engine in main.ts only wires lifecycle,
// events, debounce, status, and the applyingRemoteWrite guard around these.
// ---------------------------------------------------------------------------

export type DocSyncStatus =
  | "unchanged"
  | "created"
  | "pulled"
  | "pushed"
  | "conflict"
  | "conflict_pending"
  | "blocked_viewer"
  | "missing_local"
  | "gone";

// The server copy of an unresolved conflict is written beside the local file as `<name>.conflict.md`.
export function conflictSiblingPath(localPath: string): string {
  return `${localPath.replace(/\.md$/i, "")}.conflict.md`;
}

export interface DocSyncResult {
  documentId: string;
  localPath: string;
  status: DocSyncStatus;
  conflictPath?: string;
}

export interface SyncPassSummary {
  unchanged: number;
  created: number;
  pulled: number;
  pushed: number;
  conflicts: number;
  conflictsPending: number;
  blockedViewer: number;
  missingLocal: number;
  gone: number;
  attachmentsDownloaded: number;
  attachmentsUploaded: number;
  attachmentsDeleted: number;
  errors: number;
}

export interface AttachmentSyncSummary {
  downloaded: number;
  uploaded: number;
  deleted: number;
  skipped: number;
}

// Reconcile one linked document. Decision table:
//   local diverged (checksum != tracked)  -> push (a stale base yields a clean 409 -> conflict)
//   server moved & local unchanged         -> pull (write server content, advance meta)
//   server moved & local missing           -> pull (re-materialize the file)
//   otherwise                               -> unchanged
export async function syncLinkedDocument(deps: SyncDeps, entry: ServerMetaEntry): Promise<DocSyncResult> {
  const base = { documentId: entry.documentId, localPath: entry.localPath };

  let remote: RemoteDocumentWithContent;
  try {
    remote = await deps.api.getDocument(entry.documentId);
  } catch (error) {
    // Existence-hiding: a deleted document or a revoked grant returns 404. Report it as gone and
    // leave the local file untouched (the user keeps their copy); don't retry-loop.
    if (error instanceof PagedenApiError && error.status === 404) return { ...base, status: "gone" };
    throw error;
  }

  const serverMoved = (remote.version ?? "") !== entry.baseVersion;
  const localExists = await deps.vault.exists(entry.localPath);

  // A previously-recorded conflict freezes the document until the user resolves it (deletes the
  // *.conflict.md sibling). Without this, background auto-push would silently push the local side
  // on the next pass and discard the server changes the user never reconciled.
  if (await deps.vault.exists(conflictSiblingPath(entry.localPath))) {
    return { ...base, status: "conflict_pending", conflictPath: conflictSiblingPath(entry.localPath) };
  }

  let localCanonical = "";
  if (localExists) {
    localCanonical = canonicalize(await deps.vault.read(entry.localPath));
    const localDiverged = (await checksum(localCanonical)) !== entry.checksum;
    if (localDiverged) {
      // Reconcile permission from the live fetch: a downgrade to viewer means we must NOT push,
      // even if the stored meta still says editor.
      if (remote.permission === "viewer") {
        if (serverMoved) {
          const conflictPath = await writeConflictFile(deps.vault, entry.localPath, remote);
          await deps.meta.upsert(metaFromRemote(remote, entry.localPath));
          return { ...base, status: "conflict", conflictPath };
        }
        await deps.meta.upsert({ ...entry, permission: "viewer" });
        return { ...base, status: "blocked_viewer" };
      }
      const pushed = await pushLocalDocument(deps, entry.localPath);
      if (pushed.status === "pushed") return { ...base, status: "pushed" };
      if (pushed.status === "conflict") return { ...base, status: "conflict", conflictPath: pushed.conflictPath };
      return { ...base, status: "blocked_viewer" };
    }
  }

  if (!localExists) {
    // The user deleted a tracked file locally; don't resurrect it. Leave meta so a manual
    // re-download can re-link it.
    return { ...base, status: "missing_local" };
  }

  if (serverMoved) {
    // Re-read immediately before writing to close the TOCTOU window between the divergence check
    // above and the write: if the file changed in between, treat it as a conflict, never clobber.
    const fresh = canonicalize(await deps.vault.read(entry.localPath));
    if ((await checksum(fresh)) !== entry.checksum) {
      const conflictPath = await writeConflictFile(deps.vault, entry.localPath, remote);
      await deps.meta.upsert(metaFromRemote(remote, entry.localPath));
      return { ...base, status: "conflict", conflictPath };
    }
    await applyRemotePull(deps, entry.localPath, remote);
    return { ...base, status: "pulled" };
  }

  // Unchanged content; still reconcile a permission change so the UI/gating stays accurate.
  if (remote.permission !== entry.permission) {
    await deps.meta.upsert({ ...entry, permission: remote.permission });
  }
  if (hasAttachmentSupport(deps)) {
    await syncDocumentAttachments(deps, { ...entry, permission: remote.permission }, localCanonical);
  }
  return { ...base, status: "unchanged" };
}

async function applyRemotePull(deps: SyncDeps, localPath: string, remote: RemoteDocumentWithContent): Promise<void> {
  const parent = localPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolder(deps.vault, parent);
  const content = canonicalize(remote.content);
  await deps.vault.write(localPath, content);
  const meta = metaFromRemote(remote, localPath);
  await deps.meta.upsert(meta);
  if (hasAttachmentSupport(deps)) await syncDocumentAttachments(deps, meta, content);
}

// Run one pass over every linked document. Per-document errors are isolated so one failure
// (or one offline document) does not abort the rest of the pass.
export async function runBackgroundSyncPass(
  deps: BackgroundSyncDeps,
  onResult?: (result: DocSyncResult) => void,
): Promise<SyncPassSummary> {
  const summary: SyncPassSummary = {
    unchanged: 0,
    created: 0,
    pulled: 0,
    pushed: 0,
    conflicts: 0,
    conflictsPending: 0,
    blockedViewer: 0,
    missingLocal: 0,
    gone: 0,
    attachmentsDownloaded: 0,
    attachmentsUploaded: 0,
    attachmentsDeleted: 0,
    errors: 0,
  };
  const entries = await deps.meta.list();
  const linkedLocalPaths = new Set(entries.map((entry) => normalizePath(entry.localPath)));
  for (const entry of entries) {
    try {
      const result = await syncLinkedDocument(deps, entry);
      onResult?.(result);
      switch (result.status) {
        case "unchanged": summary.unchanged += 1; break;
        case "created": summary.created += 1; break;
        case "pulled": summary.pulled += 1; break;
        case "pushed": summary.pushed += 1; break;
        case "conflict": summary.conflicts += 1; break;
        case "conflict_pending": summary.conflictsPending += 1; break;
        case "blocked_viewer": summary.blockedViewer += 1; break;
        case "missing_local": summary.missingLocal += 1; break;
        case "gone": summary.gone += 1; break;
      }
    } catch {
      summary.errors += 1;
    }
  }

  if (canCreateUnlinkedLocalDocuments(deps)) {
    for (const localPath of await deps.localMarkdownPaths()) {
      const normalizedPath = normalizePath(localPath);
      if (linkedLocalPaths.has(normalizedPath) || normalizedPath.endsWith(".conflict.md")) continue;
      try {
        const result = await createRemoteDocumentFromLocal(deps, normalizedPath);
        if (result.meta) linkedLocalPaths.add(normalizePath(result.meta.localPath));
        summary.created += 1;
        onResult?.({ documentId: result.meta?.documentId ?? "", localPath: normalizedPath, status: "created" });
      } catch {
        summary.errors += 1;
      }
    }
  }
  return summary;
}

function canCreateUnlinkedLocalDocuments(deps: BackgroundSyncDeps): deps is CreateRemoteDeps & { localMarkdownPaths: () => Promise<string[]> } {
  return Boolean(deps.workspaceId && deps.localMarkdownPaths && deps.api.tree && deps.api.createFolder && deps.api.createDocument);
}

export async function syncDocumentAttachments(
  deps: SyncDeps,
  entry: ServerMetaEntry,
  markdown?: string,
): Promise<AttachmentSyncSummary> {
  const api = requireAttachmentApi(deps);
  const meta = requireAttachmentMeta(deps);
  const vault = requireBinaryVault(deps);
  const summary = emptyAttachmentSummary();
  const remote = await api.attachments(entry.documentId);
  const tracked = await meta.listAttachmentsForDocument(entry.documentId);
  const trackedById = new Map(tracked.map((item) => [item.attachmentId, item]));
  const remoteById = new Map(remote.attachments.map((item) => [item.id, item]));
  const content = markdown ?? (await deps.vault.exists(entry.localPath) ? await deps.vault.read(entry.localPath) : "");
  const referenced = entry.permission === "viewer" ? new Set<string>() : extractAttachmentPaths(content, entry.localPath);

  for (const old of tracked) {
    if (!remoteById.has(old.attachmentId)) await meta.removeAttachment(old.attachmentId);
  }

  if (entry.permission !== "viewer") {
    for (const old of tracked) {
      if (!remoteById.has(old.attachmentId) || referenced.has(old.localPath) || (await deps.vault.exists(old.localPath))) continue;
      await api.deleteAttachment(old.attachmentId);
      await meta.removeAttachment(old.attachmentId);
      remoteById.delete(old.attachmentId);
      summary.deleted += 1;
    }
  }

  for (const attachment of remote.attachments) {
    if (!remoteById.has(attachment.id)) continue;
    const localPath = trackedById.get(attachment.id)?.localPath ?? attachmentLocalPath(entry.localPath, attachment.filename);
    if (!(await deps.vault.exists(localPath)) || trackedById.get(attachment.id)?.sha256 !== attachment.sha256) {
      await ensureParent(deps.vault, localPath);
      await vault.writeBinary(localPath, await api.downloadAttachment(attachment.id));
      summary.downloaded += 1;
    }
    await meta.upsertAttachment(metaFromAttachment(entry.documentId, localPath, attachment));
  }

  if (entry.permission === "viewer") return summary;
  const trackedByPath = new Map((await meta.listAttachmentsForDocument(entry.documentId)).map((item) => [item.localPath, item]));

  for (const localPath of referenced) {
    if (!(await deps.vault.exists(localPath))) {
      summary.skipped += 1;
      continue;
    }
    const bytes = await vault.readBinary(localPath);
    const sha256 = await sha256Hex(bytes);
    const existing = trackedByPath.get(localPath);
    if (existing?.sha256 === sha256) {
      summary.skipped += 1;
      continue;
    }
    const uploaded = await api.uploadAttachment(entry.documentId, localPath.split("/").pop() ?? "attachment", bytes, contentTypeForPath(localPath));
    if (existing) {
      await api.deleteAttachment(existing.attachmentId);
      await meta.removeAttachment(existing.attachmentId);
      summary.deleted += 1;
    }
    await meta.upsertAttachment(metaFromAttachment(entry.documentId, localPath, uploaded));
    summary.uploaded += 1;
  }

  return summary;
}

function emptyAttachmentSummary(): AttachmentSyncSummary {
  return { downloaded: 0, uploaded: 0, deleted: 0, skipped: 0 };
}

function hasAttachmentSupport(deps: SyncDeps): boolean {
  return Boolean(
    deps.api.attachments &&
      deps.api.uploadAttachment &&
      deps.api.downloadAttachment &&
      deps.api.deleteAttachment &&
      deps.vault.readBinary &&
      deps.vault.writeBinary &&
      typeof deps.meta.listAttachmentsForDocument === "function" &&
      typeof deps.meta.upsertAttachment === "function" &&
      typeof deps.meta.removeAttachment === "function",
  );
}

function requireAttachmentApi(deps: SyncDeps): Required<Pick<PagedenApiClient, "attachments" | "uploadAttachment" | "downloadAttachment" | "deleteAttachment">> {
  if (!deps.api.attachments || !deps.api.uploadAttachment || !deps.api.downloadAttachment || !deps.api.deleteAttachment) {
    throw new Error("Attachment sync requires attachment API methods.");
  }
  return deps.api as Required<Pick<PagedenApiClient, "attachments" | "uploadAttachment" | "downloadAttachment" | "deleteAttachment">>;
}

function requireAttachmentMeta(deps: SyncDeps): Required<Pick<MetaStoreLike, "listAttachmentsForDocument" | "upsertAttachment" | "removeAttachment">> {
  if (!deps.meta.listAttachmentsForDocument || !deps.meta.upsertAttachment || !deps.meta.removeAttachment) {
    throw new Error("Attachment sync requires attachment metadata methods.");
  }
  return deps.meta as Required<Pick<MetaStoreLike, "listAttachmentsForDocument" | "upsertAttachment" | "removeAttachment">>;
}

function requireBinaryVault(deps: SyncDeps): Required<Pick<VaultLike, "readBinary" | "writeBinary">> {
  if (!deps.vault.readBinary || !deps.vault.writeBinary) {
    throw new Error("Attachment sync requires binary vault methods.");
  }
  return deps.vault as Required<Pick<VaultLike, "readBinary" | "writeBinary">>;
}

function metaFromAttachment(documentId: string, localPath: string, attachment: Attachment): ServerMetaAttachmentEntry {
  return {
    attachmentId: attachment.id,
    documentId,
    localPath,
    filename: attachment.filename,
    sha256: attachment.sha256,
    size: attachment.size,
    contentType: attachment.contentType,
    createdAt: attachment.createdAt,
  };
}

function attachmentLocalPath(documentPath: string, filename: string): string {
  const parent = documentPath.split("/").slice(0, -1).join("/");
  return normalizePath(`${parent}/${filename}`);
}

async function ensureParent(vault: VaultLike, path: string): Promise<void> {
  const parent = path.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolder(vault, parent);
}

export function extractAttachmentPaths(markdown: string, documentPath: string): Set<string> {
  const parent = documentPath.split("/").slice(0, -1).join("/");
  const out = new Set<string>();
  const push = (raw: string) => {
    const target = raw.trim();
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.endsWith(".md")) return;
    const clean = target.split(/[?#]/)[0] ?? "";
    if (!clean) return;
    out.add(normalizePath(clean.startsWith("/") ? clean.slice(1) : `${parent}/${clean}`));
  };
  for (const match of markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)|\[[^\]]+]\(([^)]+)\)/g)) {
    push(match[1] ?? match[2] ?? "");
  }
  for (const match of markdown.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]/g)) {
    push(match[1] ?? "");
  }
  return out;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}
