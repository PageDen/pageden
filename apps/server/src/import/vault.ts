// Server-side vault import worker (see pageden-dev docs/SERVER-SIDE-VAULT-IMPORT-PLAN.md).
//
// One uploaded zip becomes one ImportJob; processing runs in-process, decoupled from any
// client connection, and creates folders/documents/attachments through the same internal
// write paths the HTTP routes use. Jobs are claimed with an atomic queued->running DB
// transition, heartbeat at every checkpoint flush, and are safe to retry: `skip` policy is
// inherently idempotent and `rename` consults the per-entry checkpoint.

import { Unzip, UnzipInflate } from "fflate";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { readImportZipStream, removeImportZip, writeContent, writeBlob } from "../storage.js";
import { checksum as computeChecksum } from "../checksum.js";
import { searchTextFor } from "../documents/routes.js";
import { lockFolderTree } from "../db.js";
import { buildDocumentPath, buildFolderPath } from "../paths.js";
import { atLeast, canManageWorkspace, resolveFolderRole } from "../permissions/index.js";
import { writeAuditEvent } from "../audit.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const IMPORT_LIMITS = {
  maxZipBytes: () => intEnv("IMPORT_MAX_ZIP_MB", 200) * 1024 * 1024,
  maxEntries: () => intEnv("IMPORT_MAX_ENTRIES", 20000),
  maxUncompressedBytes: () => intEnv("IMPORT_MAX_UNCOMPRESSED_MB", 2048) * 1024 * 1024,
  maxFileBytes: () => intEnv("IMPORT_MAX_FILE_MB", 50) * 1024 * 1024,
  jobTimeoutMs: () => intEnv("IMPORT_JOB_TIMEOUT_MINUTES", 30) * 60 * 1000,
  checkpointEvery: () => intEnv("IMPORT_CHECKPOINT_EVERY", 50),
};

export interface ImportJobParams {
  conflictPolicy: "skip" | "rename";
  targetFolderId?: string;
  targetRootName?: string;
}

export type ImportReportRow = { path: string; status: "created" | "skipped" | "warning"; message: string };

interface ImportReport {
  foldersCreated: number;
  documentsCreated: number;
  documentsSkipped: number;
  attachmentsUploaded: number;
  attachmentWarnings: string[];
  rows: ImportReportRow[];
  /** Note paths already created — the retry/rename idempotency checkpoint. */
  processedPaths: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (ported from the web importer so both produce identical structures)
// ---------------------------------------------------------------------------
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function dirnameOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basenameOf(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() ?? "";
}

function extensionFor(path: string): string {
  const name = basenameOf(path);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export function isIgnoredPath(path: string): boolean {
  const parts = normalizePath(path).split("/");
  return parts.includes(".obsidian") || parts.includes(".trash") || parts.includes(".git");
}

/** Reject zip-slip attempts: absolute paths or any traversal outside the archive root. */
export function isUnsafeZipPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true;
  const parts = normalized.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") depth -= 1;
    else if (part && part !== ".") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

export function slugifyImport(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function normalizeMarkdown(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function frontmatterTitle(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end);
  const match = block.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return match?.[1]?.trim() || null;
}

export function extractAttachmentRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of markdown.matchAll(/!\[[^\]]*]\((?![a-z][a-z0-9+.-]*:)([^)\s]+)(?:\s+"[^"]*")?\)/gi)) {
    if (match[1]) {
      try {
        refs.add(decodeURIComponent(match[1]));
      } catch {
        refs.add(match[1]);
      }
    }
  }
  return [...refs];
}

function commonRoot(paths: string[]): string | null {
  const firstSegments = paths[0]?.split("/").filter(Boolean);
  if (!firstSegments || firstSegments.length < 2) return null;
  const root = firstSegments[0]!;
  for (const path of paths) {
    const first = path.split("/").filter(Boolean)[0];
    if (first !== root) return null;
  }
  return root;
}

function stripRoot(path: string, root: string): string {
  return path === root ? basenameOf(path) : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

// ---------------------------------------------------------------------------
// Zip scanning (streaming, two passes over the stored zip)
// ---------------------------------------------------------------------------
interface ZipScanOptions {
  /** Return true to collect this entry's bytes; false to skip its data but count it. */
  wantData: (path: string) => boolean;
  onEntry: (path: string, data: Buffer | null) => void;
}

/**
 * Stream the zip through fflate's push-based Unzip. Entries are decompressed one at a
 * time; only entries `wantData` selects are buffered (each bounded by the per-file cap).
 */
async function scanZip(storageKey: string, opts: ZipScanOptions): Promise<void> {
  const maxEntries = IMPORT_LIMITS.maxEntries();
  const maxFile = IMPORT_LIMITS.maxFileBytes();
  const maxTotal = IMPORT_LIMITS.maxUncompressedBytes();
  let entries = 0;
  let total = 0;
  let failure: Error | null = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    const rawName = file.name;
    if (failure) return;
    if (rawName.endsWith("/")) return; // directory entry
    entries += 1;
    if (entries > maxEntries) {
      failure = new Error(`Zip has too many entries (limit ${maxEntries}).`);
      return;
    }
    const path = normalizePath(rawName);
    if (isUnsafeZipPath(path)) {
      failure = new Error(`Zip entry has an unsafe path: ${rawName}`);
      return;
    }
    const want = opts.wantData(path);
    const chunks: Buffer[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > maxFile) {
        failure = new Error(`Zip entry ${path} exceeds the per-file limit.`);
        return;
      }
      if (total > maxTotal) {
        failure = new Error(`Zip uncompressed size exceeds the limit.`);
        return;
      }
      if (want) chunks.push(Buffer.from(chunk));
      if (final) opts.onEntry(path, want ? Buffer.concat(chunks) : null);
    };
    file.start();
  };

  const stream = await readImportZipStream(storageKey);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (failure) break;
    unzip.push(new Uint8Array(chunk), false);
  }
  if (!failure) unzip.push(new Uint8Array(0), true);
  if (failure) throw failure;
}

// ---------------------------------------------------------------------------
// Internal create helpers (same locking/audit semantics as the HTTP routes)
// ---------------------------------------------------------------------------
interface FolderRef {
  id: string;
  path: string;
}

async function createFolderInternal(
  workspaceId: string,
  userId: string,
  parent: FolderRef | null,
  name: string,
  slug: string,
): Promise<FolderRef> {
  return prisma.$transaction(async (tx) => {
    await lockFolderTree(tx, workspaceId);
    const existing = await tx.folder.findFirst({
      where: { workspaceId, parentFolderId: parent?.id ?? null, slug, deletedAt: null },
      select: { id: true, path: true },
    });
    if (existing) return existing;
    const path = buildFolderPath(parent?.path ?? null, slug);
    const folder = await tx.folder.create({
      data: {
        workspaceId,
        parentFolderId: parent?.id ?? null,
        name,
        slug,
        path,
        createdById: userId,
        updatedById: userId,
      },
    });
    await writeAuditEvent(
      { workspaceId, userId, action: "folder_created", targetType: "folder", targetId: folder.id, metadata: { path, via: "import" } },
      tx,
    );
    return { id: folder.id, path: folder.path };
  });
}

async function createDocumentInternal(
  workspaceId: string,
  userId: string,
  folder: FolderRef,
  title: string,
  slug: string,
  content: string,
): Promise<{ id: string; path: string }> {
  const sum = computeChecksum(content);
  const { storageKey } = await writeContent(content, workspaceId);
  return prisma.$transaction(async (tx) => {
    await lockFolderTree(tx, workspaceId);
    const path = buildDocumentPath(folder.path, slug);
    const doc = await tx.document.create({
      data: { workspaceId, folderId: folder.id, title, slug, path, createdById: userId, updatedById: userId },
    });
    const revision = await tx.documentRevision.create({
      data: { documentId: doc.id, versionNumber: 1, storageKey, checksum: sum, createdById: userId, changeSource: "import" },
    });
    const updated = await tx.document.update({
      where: { id: doc.id },
      data: { currentVersionId: revision.id, currentChecksum: sum, searchText: searchTextFor(content) },
    });
    await writeAuditEvent(
      {
        workspaceId,
        userId,
        action: "document_created",
        targetType: "document",
        targetId: doc.id,
        metadata: { path, version: revision.id, via: "import" },
      },
      tx,
    );
    return { id: doc.id, path: updated.path };
  });
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------
let workerRunning = false;

/** Kick the single-flight worker loop (no-op if it is already draining the queue). */
export function kickImportWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  void (async () => {
    try {
      for (;;) {
        const job = await prisma.importJob.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
        if (!job) break;
        await runJob(job.id);
      }
    } catch (error) {
      console.error("import worker loop failed", error);
    } finally {
      workerRunning = false;
    }
  })();
}

/** On boot: jobs that were mid-flight when the process died are failed (retryable). */
export async function failInterruptedImportJobs(): Promise<void> {
  await prisma.importJob.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "Interrupted by a server restart — retry to resume.", finishedAt: new Date() },
  });
}

/** Watchdog + cleanup: fail jobs with a stale heartbeat; purge finished jobs after 24h. */
export async function importJobMaintenance(): Promise<void> {
  const staleBefore = new Date(Date.now() - IMPORT_LIMITS.jobTimeoutMs());
  await prisma.importJob.updateMany({
    where: { status: "running", lastHeartbeatAt: { lt: staleBefore } },
    data: { status: "failed", error: "Timed out — retry to resume.", finishedAt: new Date() },
  });
  const purgeBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const old = await prisma.importJob.findMany({
    where: { status: { in: ["done", "failed"] }, finishedAt: { lt: purgeBefore } },
    select: { id: true, storageKey: true },
  });
  for (const job of old) {
    await removeImportZip(job.storageKey).catch(() => {});
    await prisma.importJob.delete({ where: { id: job.id } }).catch(() => {});
  }
}

async function runJob(jobId: string): Promise<void> {
  // Atomic claim: queued -> running. Count 0 means another owner already claimed it.
  const claimed = await prisma.importJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: { status: "running", startedAt: new Date(), lastHeartbeatAt: new Date() },
  });
  if (claimed.count !== 1) return;

  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
  try {
    const report = await processJob(job.id, job.workspaceId, job.userId, job.params as unknown as ImportJobParams, job.report);
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        report: report as object,
        progress: { phase: "done", current: report.documentsCreated, total: report.documentsCreated, label: "Import complete" },
      },
    });
  } catch (error) {
    await prisma.importJob
      .update({
        where: { id: job.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : "Import failed.",
        },
      })
      .catch(() => {});
  }
}

async function processJob(
  jobId: string,
  workspaceId: string,
  userId: string,
  params: ImportJobParams,
  priorReport: unknown,
): Promise<ImportReport> {
  const job = { id: jobId };
  const checkpointEvery = IMPORT_LIMITS.checkpointEvery();
  const prior = (priorReport ?? null) as ImportReport | null;
  const alreadyProcessed = new Set(prior?.processedPaths ?? []);

  // -- Pass 1: collect note contents (small) and attachment paths (metadata only).
  const notes: Array<{ path: string; content: string }> = [];
  const attachmentPaths: string[] = [];
  await scanZip(jobStorageKey(workspaceId, jobId), {
    wantData: (path) => extensionFor(path) === "md" && !isIgnoredPath(path),
    onEntry: (path, data) => {
      if (isIgnoredPath(path)) return;
      if (extensionFor(path) === "md") {
        if (!path.toLowerCase().endsWith(".conflict.md")) {
          notes.push({ path, content: normalizeMarkdown(data!.toString("utf8")) });
        }
      } else {
        attachmentPaths.push(path);
      }
    },
  });

  // Strip a single common root directory (zips of a vault folder usually have one).
  const allPaths = [...notes.map((n) => n.path), ...attachmentPaths];
  const root = commonRoot(allPaths);
  if (root) {
    for (const note of notes) note.path = stripRoot(note.path, root);
    for (let i = 0; i < attachmentPaths.length; i += 1) attachmentPaths[i] = stripRoot(attachmentPaths[i]!, root);
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));

  const attachmentByPath = new Map<string, string>();
  const attachmentByName = new Map<string, string[]>();
  for (const path of attachmentPaths) {
    attachmentByPath.set(path, path);
    const list = attachmentByName.get(basenameOf(path)) ?? [];
    list.push(path);
    attachmentByName.set(basenameOf(path), list);
  }

  // -- Destination root folder.
  const report: ImportReport = {
    foldersCreated: prior?.foldersCreated ?? 0,
    documentsCreated: prior?.documentsCreated ?? 0,
    documentsSkipped: 0,
    attachmentsUploaded: prior?.attachmentsUploaded ?? 0,
    attachmentWarnings: [],
    rows: [],
    processedPaths: [...alreadyProcessed],
  };

  let rootFolder: FolderRef;
  if (params.targetFolderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: params.targetFolderId, workspaceId, deletedAt: null },
      select: { id: true, path: true },
    });
    if (!folder) throw new Error("Target folder not found.");
    const role = await resolveFolderRole(userId, folder.id);
    if (role === null || !atLeast(role, "editor")) throw new Error("No permission to import into the target folder.");
    rootFolder = folder;
  } else {
    const name = (params.targetRootName ?? "Imported").trim() || "Imported";
    if (!(await canManageWorkspace(userId, workspaceId))) {
      throw new Error("Only workspace admins can create a new top-level folder.");
    }
    rootFolder = await createFolderInternal(workspaceId, userId, null, name, slugifyImport(name));
    report.foldersCreated += 1;
  }

  // Existing document paths (for skip/rename) and folder cache.
  const existingDocs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { path: true },
  });
  const documentPaths = new Set(existingDocs.map((d) => trimSlashes(d.path)));
  const folderCache = new Map<string, FolderRef>([["", rootFolder]]);

  const ensureFolder = async (localDir: string): Promise<FolderRef> => {
    const key = localDir
      .split("/")
      .filter(Boolean)
      .map((segment) => slugifyImport(segment))
      .join("/");
    if (folderCache.has(key)) return folderCache.get(key)!;
    let parent = rootFolder;
    let current = "";
    for (const segment of localDir.split("/").filter(Boolean)) {
      const slug = slugifyImport(segment);
      current = current ? `${current}/${slug}` : slug;
      const cached = folderCache.get(current);
      if (cached) {
        parent = cached;
        continue;
      }
      const created = await createFolderInternal(workspaceId, userId, parent, segment, slug);
      report.foldersCreated += 1;
      folderCache.set(current, created);
      parent = created;
    }
    return parent;
  };

  // Map of attachment zip-path -> documents that reference it (for pass 2).
  const neededAttachments = new Map<string, string[]>();

  let processedSinceFlush = 0;
  const flush = async (label: string, current: number, total: number) => {
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        lastHeartbeatAt: new Date(),
        progress: { phase: "documents", current, total, label },
        report: report as object,
      },
    });
  };

  // -- Documents.
  for (const [index, note] of notes.entries()) {
    if (alreadyProcessed.has(note.path)) continue; // retry checkpoint
    const rootSlugPath = trimSlashes(rootFolder.path);
    const remotePath = remotePathForNote(note.path, rootSlugPath);
    if (documentPaths.has(remotePath) && params.conflictPolicy === "skip") {
      report.documentsSkipped += 1;
      report.rows.push({ path: note.path, status: "skipped", message: "A document with this path already exists." });
      report.processedPaths.push(note.path);
      continue;
    }
    const baseTitle = frontmatterTitle(note.content) ?? (basenameOf(note.path).replace(/\.md$/i, "") || "Untitled");
    const folder = await ensureFolder(dirnameOf(note.path));
    const folderPath = trimSlashes(folder.path);
    const baseSlug = slugifyImport(basenameOf(note.path));
    let slug = baseSlug;
    if (params.conflictPolicy === "rename") {
      let candidate = baseSlug;
      let n = 2;
      while (documentPaths.has([folderPath, `${candidate}.md`].filter(Boolean).join("/"))) {
        candidate = `${baseSlug}-${n}`;
        n += 1;
      }
      slug = candidate;
    }
    const title = slug === baseSlug ? baseTitle : `${baseTitle} (${slug.slice(baseSlug.length + 1)})`;
    const created = await createDocumentInternal(workspaceId, userId, folder, title, slug, note.content);
    report.documentsCreated += 1;
    report.rows.push({ path: note.path, status: "created", message: `Created ${created.path}` });
    report.processedPaths.push(note.path);
    documentPaths.add(trimSlashes(created.path));

    const seen = new Set<string>();
    for (const ref of extractAttachmentRefs(note.content)) {
      const resolved = resolveRef(ref, note.path, attachmentByPath, attachmentByName);
      if (resolved.status === "resolved") {
        if (seen.has(resolved.path)) continue;
        seen.add(resolved.path);
        const docs = neededAttachments.get(resolved.path) ?? [];
        docs.push(created.id);
        neededAttachments.set(resolved.path, docs);
      } else if (resolved.status === "missing") {
        const message = `${note.path} references "${ref}", but that file is not in the zip.`;
        report.attachmentWarnings.push(message);
        report.rows.push({ path: ref, status: "warning", message });
      } else {
        const message = `${note.path} references "${ref}", but multiple files share that name.`;
        report.attachmentWarnings.push(message);
        report.rows.push({ path: ref, status: "warning", message });
      }
    }

    processedSinceFlush += 1;
    if (processedSinceFlush >= checkpointEvery) {
      processedSinceFlush = 0;
      await flush(note.path, index + 1, notes.length);
    }
  }
  await flush("Uploading attachments", notes.length, notes.length);

  // -- Pass 2: stream the zip again, uploading only referenced attachments.
  if (neededAttachments.size > 0) {
    const wanted = new Set(neededAttachments.keys());
    const uploads: Array<Promise<void>> = [];
    await scanZip(jobStorageKey(workspaceId, jobId), {
      wantData: (path) => wanted.has(root ? stripRoot(path, root) : path),
      onEntry: (path, data) => {
        const relPath = root ? stripRoot(path, root) : path;
        if (!data || !wanted.has(relPath)) return;
        const docIds = neededAttachments.get(relPath) ?? [];
        // Synchronous callback: queue the async work and settle it after the scan.
        uploads.push(
          (async () => {
            const { storageKey, hex, size } = await writeBlob(data, workspaceId);
            for (const documentId of docIds) {
              await prisma.attachment.create({
                data: {
                  workspaceId,
                  documentId,
                  filename: basenameOf(relPath),
                  contentType: contentTypeFor(relPath),
                  size,
                  sha256: hex,
                  storageKey,
                  uploadedById: userId,
                },
              });
              report.attachmentsUploaded += 1;
            }
          })().catch((error: unknown) => {
            const message = `Could not upload ${relPath}: ${error instanceof Error ? error.message : "unknown error"}`;
            report.attachmentWarnings.push(message);
            report.rows.push({ path: relPath, status: "warning", message });
          }),
        );
      },
    });
    await Promise.all(uploads);
  }

  return report;
}

function jobStorageKey(workspaceId: string, jobId: string): string {
  return `import/${workspaceId}/${jobId}.zip`;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function remotePathForNote(path: string, targetRootPath: string): string {
  const localDir = dirnameOf(path).split("/").filter(Boolean).map(slugifyImport).join("/");
  const docSlug = slugifyImport(basenameOf(path));
  return [targetRootPath, localDir, `${docSlug}.md`].filter(Boolean).join("/");
}

function resolveRef(
  ref: string,
  notePath: string,
  byPath: Map<string, string>,
  byName: Map<string, string[]>,
): { status: "resolved"; path: string } | { status: "missing" } | { status: "ambiguous" } {
  const clean = normalizePath(ref.replace(/^<|>$/g, ""));
  const noteDir = dirnameOf(notePath);
  for (const candidate of [normalizePath(`${noteDir}/${clean}`), clean]) {
    if (byPath.has(candidate)) return { status: "resolved", path: candidate };
  }
  const matches = byName.get(basenameOf(clean)) ?? [];
  if (matches.length === 1) return { status: "resolved", path: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "missing" };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
};

function contentTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extensionFor(path)] ?? "application/octet-stream";
}

/** Used by routes to give new jobs a unique, key-safe id without an extra DB round-trip. */
export function newImportJobId(): string {
  return `imp${randomBytes(12).toString("hex")}`;
}
