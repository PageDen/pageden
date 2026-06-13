import { api, ApiError } from "../../lib/api";
import type { z } from "zod";
import type { treeSchema } from "@pageden/api-types";
import { frontmatterTitle } from "../document/frontmatter";

export interface BrowserImportFile {
  file: File;
  path: string;
  originalPath: string;
  name: string;
  extension: string;
}

export interface WebImportPreview {
  targetRootName: string;
  targetRootSlug: string;
  notes: number;
  attachments: number;
  skipped: number;
  frontmatter: number;
  conflicts: string[];
  attachmentWarnings: string[];
  samplePaths: string[];
}

export interface WebImportReport extends WebImportPreview {
  foldersCreated: number;
  documentsCreated: number;
  documentsSkipped: number;
  attachmentsUploaded: number;
  attachmentWarnings: string[];
  rows: ImportReportRow[];
}

type Tree = z.infer<typeof treeSchema>;
type RemoteFolder = Tree["folders"][number];

export type ImportReportRow =
  | { path: string; status: "created"; message: string }
  | { path: string; status: "skipped"; message: string }
  | { path: string; status: "warning"; message: string };

export type ImportProgress = {
  phase: "folders" | "documents" | "attachments" | "done";
  current: number;
  total: number;
  label: string;
};

export type ImportConflictPolicy = "skip" | "rename";

export function filesFromFileList(list: FileList | File[]): BrowserImportFile[] {
  const raw = Array.from(list).map((file) => ({
    file,
    path: normalizePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  }));
  const root = commonRoot(raw.map((item) => item.path));
  return raw.map(({ file, path }) => {
    const relativePath = root ? stripRoot(path, root) : path;
    return {
      file,
      path: relativePath,
      originalPath: path,
      name: basename(relativePath),
      extension: extensionFor(relativePath),
    };
  });
}

export async function buildWebImportPreview(files: BrowserImportFile[], tree: Tree, targetRootName: string): Promise<WebImportPreview> {
  const importable = splitImportable(files);
  const attachmentIndex = buildAttachmentIndex(importable.attachments);
  const targetRootSlug = slugify(targetRootName);
  const remoteDocumentPaths = new Set(tree.documents.map((doc) => trimSlashes(doc.path)));
  const conflicts = importable.notes
    .map((file) => remotePathForNote(file.path, targetRootSlug))
    .filter((path) => remoteDocumentPaths.has(path))
    .sort();
  let frontmatter = 0;
  for (const note of importable.notes) {
    if ((await note.file.text()).startsWith("---")) frontmatter += 1;
  }
  const attachmentWarnings = await buildAttachmentWarnings(importable.notes, attachmentIndex);
  return {
    targetRootName,
    targetRootSlug,
    notes: importable.notes.length,
    attachments: importable.attachments.length,
    skipped: importable.skipped,
    frontmatter,
    conflicts,
    attachmentWarnings,
    samplePaths: importable.notes.slice(0, 5).map((file) => file.path),
  };
}

export async function importFilesToWorkspace({
  workspaceId,
  files,
  tree,
  targetRootName,
  conflictPolicy = "skip",
  onProgress,
}: {
  workspaceId: string;
  files: BrowserImportFile[];
  tree: Tree;
  targetRootName: string;
  conflictPolicy?: ImportConflictPolicy;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<WebImportReport> {
  const preview = await buildWebImportPreview(files, tree, targetRootName);
  const importable = splitImportable(files);
  const attachmentIndex = buildAttachmentIndex(importable.attachments);
  const folderByPath = new Map(tree.folders.map((folder) => [trimSlashes(folder.path), folder]));
  const documentPaths = new Set(tree.documents.map((doc) => trimSlashes(doc.path)));
  let foldersCreated = 0;
  let documentsCreated = 0;
  let documentsSkipped = 0;
  let attachmentsUploaded = 0;
  const attachmentWarnings = [...preview.attachmentWarnings];
  const rows: ImportReportRow[] = preview.attachmentWarnings.map((message) => ({
    path: "Referenced attachment",
    status: "warning",
    message,
  }));

  function emit(phase: ImportProgress["phase"], current: number, total: number, label: string) {
    onProgress?.({ phase, current, total, label });
  }

  async function ensureFolder(localDir: string): Promise<RemoteFolder> {
    const targetRootSlug = preview.targetRootSlug;
    let parent = folderByPath.get(targetRootSlug);
    if (!parent) {
      const created = await withRateLimitRetry(() =>
        api.createFolder({ workspaceId, parentFolderId: null, name: targetRootName, slug: targetRootSlug }),
      );
      parent = { id: created.id, path: created.path, parentFolderId: null, name: targetRootName, slug: targetRootSlug, permission: "manager" };
      folderByPath.set(trimSlashes(created.path), parent);
      foldersCreated += 1;
    }

    let currentPath = targetRootSlug;
    for (const segment of localDir.split("/").filter(Boolean)) {
      const slug = slugify(segment);
      currentPath = `${currentPath}/${slug}`;
      const existing = folderByPath.get(currentPath);
      if (existing) {
        parent = existing;
        continue;
      }
      const parentFolderId: string = parent.id;
      const created = await withRateLimitRetry(() =>
        api.createFolder({ workspaceId, parentFolderId, name: segment, slug }),
      );
      parent = { id: created.id, path: created.path, parentFolderId: parent.id, name: segment, slug, permission: "manager" };
      folderByPath.set(trimSlashes(created.path), parent);
      foldersCreated += 1;
    }
    return parent;
  }

  emit("documents", 0, importable.notes.length, "Starting import");
  for (const [index, note] of importable.notes.entries()) {
    emit("documents", index + 1, importable.notes.length, note.path);
    let remotePath = remotePathForNote(note.path, preview.targetRootSlug);
    if (documentPaths.has(remotePath)) {
      if (conflictPolicy === "skip") {
        documentsSkipped += 1;
        rows.push({ path: note.path, status: "skipped", message: "A document with this path already exists." });
        continue;
      }
    }
    const content = normalizeMarkdown(await note.file.text());
    const baseTitle = frontmatterTitle(content) ?? (basename(note.path).replace(/\.md$/i, "") || "Untitled");
    const folder = await ensureFolder(dirname(note.path));
    const folderPath = trimSlashes(folder.path);
    const baseSlug = slugify(basename(note.path).replace(/\.md$/i, ""));
    const slug = conflictPolicy === "rename" ? uniqueDocumentSlug(baseSlug, folderPath, documentPaths) : baseSlug;
    if (slug !== baseSlug) remotePath = [folderPath, `${slug}.md`].filter(Boolean).join("/");
    const title = slug === baseSlug ? baseTitle : `${baseTitle} (${slug.replace(new RegExp(`^${escapeRegExp(baseSlug)}-?`), "")})`;
    const created = await withRateLimitRetry(() =>
      api.createDocument({
        workspaceId,
        folderId: folder.id,
        title,
        slug,
        content,
      }),
    );
    documentsCreated += 1;
    rows.push({ path: note.path, status: "created", message: remotePath === remotePathForNote(note.path, preview.targetRootSlug) ? `Created ${created.path}` : `Created duplicate as ${created.path}` });
    documentPaths.add(trimSlashes(created.path));

    const uploaded = new Set<string>();
    for (const ref of extractAttachmentRefs(content)) {
      const attachment = resolveAttachmentRef(ref, note.path, attachmentIndex);
      if (attachment.status !== "resolved" || uploaded.has(attachment.file.path)) continue;
      uploaded.add(attachment.file.path);
      try {
        emit("attachments", attachmentsUploaded + 1, importable.attachments.length, attachment.file.path);
        await uploadAttachmentWithRetry(created.id, attachment.file.file);
        attachmentsUploaded += 1;
      } catch (error) {
        const message = `Could not upload ${attachment.file.path}: ${error instanceof Error ? error.message : "unknown error"}`;
        attachmentWarnings.push(message);
        rows.push({ path: attachment.file.path, status: "warning", message });
      }
    }
  }

  emit("done", importable.notes.length, importable.notes.length, "Import complete");
  return { ...preview, foldersCreated, documentsCreated, documentsSkipped, attachmentsUploaded, attachmentWarnings, rows };
}

export function buildImportReportMarkdown(report: WebImportReport): string {
  const lines = [
    "# Pageden Import Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Destination folder: ${report.targetRootName} (${report.targetRootSlug})`,
    "",
    "## Summary",
    "",
    `- Markdown notes found: ${report.notes}`,
    `- Attachments found: ${report.attachments}`,
    `- Notes with frontmatter: ${report.frontmatter}`,
    `- Internal/conflict files skipped before import: ${report.skipped}`,
    `- Existing remote documents found: ${report.conflicts.length}`,
    `- Folders created: ${report.foldersCreated}`,
    `- Documents created: ${report.documentsCreated}`,
    `- Documents skipped: ${report.documentsSkipped}`,
    `- Attachments uploaded: ${report.attachmentsUploaded}`,
    `- Attachment warnings: ${report.attachmentWarnings.length}`,
    "",
  ];

  if (report.conflicts.length) {
    lines.push("## Existing Documents", "", ...report.conflicts.map((path) => `- ${path}`), "");
  }

  if (report.attachmentWarnings.length) {
    lines.push("## Attachment Warnings", "", ...report.attachmentWarnings.map((warning) => `- ${warning}`), "");
  }

  if (report.rows.length) {
    lines.push("## File Results", "", "| File | Status | Result |", "| --- | --- | --- |");
    for (const row of report.rows) {
      lines.push(`| ${escapeTableCell(row.path)} | ${row.status} | ${escapeTableCell(row.message)} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function extractAttachmentRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of markdown.matchAll(/!\[[^\]]*]\((?![a-z][a-z0-9+.-]*:)([^)\s]+)(?:\s+"[^"]*")?\)/gi)) {
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

function splitImportable(files: BrowserImportFile[]) {
  let skipped = 0;
  const notes: BrowserImportFile[] = [];
  const attachments: BrowserImportFile[] = [];
  for (const file of files) {
    if (isIgnoredPath(file.path)) {
      skipped += 1;
      continue;
    }
    if (file.extension === "md") {
      if (file.path.toLowerCase().endsWith(".conflict.md")) skipped += 1;
      else notes.push(file);
    } else {
      attachments.push(file);
    }
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));
  return { notes, attachments, skipped };
}

function buildAttachmentIndex(files: BrowserImportFile[]) {
  const byPath = new Map<string, BrowserImportFile>();
  const byName = new Map<string, BrowserImportFile[]>();
  for (const file of files) {
    byPath.set(file.path, file);
    const list = byName.get(file.name) ?? [];
    list.push(file);
    byName.set(file.name, list);
  }
  return { byPath, byName };
}

type AttachmentResolution =
  | { status: "resolved"; file: BrowserImportFile }
  | { status: "missing"; ref: string }
  | { status: "ambiguous"; ref: string; matches: BrowserImportFile[] };

async function buildAttachmentWarnings(notes: BrowserImportFile[], index: ReturnType<typeof buildAttachmentIndex>): Promise<string[]> {
  const warnings = new Set<string>();
  for (const note of notes) {
    for (const ref of extractAttachmentRefs(await note.file.text())) {
      const resolved = resolveAttachmentRef(ref, note.path, index);
      if (resolved.status === "missing") {
        warnings.add(`${note.path} references "${ref}", but that file was not selected. The note will import, but that media link may be broken.`);
      }
      if (resolved.status === "ambiguous") {
        warnings.add(`${note.path} references "${ref}", but multiple selected files share that name (${resolved.matches.map((file) => file.path).join(", ")}). Pageden will not guess which one to attach.`);
      }
    }
  }
  return [...warnings].sort();
}

function resolveAttachmentRef(ref: string, notePath: string, index: ReturnType<typeof buildAttachmentIndex>): AttachmentResolution {
  const clean = normalizePath(ref.replace(/^<|>$/g, ""));
  const noteDir = dirname(notePath);
  for (const candidate of [normalizePath(`${noteDir}/${clean}`), clean]) {
    const found = index.byPath.get(candidate);
    if (found) return { status: "resolved", file: found };
  }
  const byName = index.byName.get(basename(clean)) ?? [];
  if (byName.length === 1) return { status: "resolved", file: byName[0]! };
  if (byName.length > 1) return { status: "ambiguous", ref, matches: byName };
  return { status: "missing", ref };
}

function remotePathForNote(path: string, targetRootSlug: string): string {
  const localDir = dirname(path).split("/").filter(Boolean).map(slugify).join("/");
  const docSlug = slugify(basename(path));
  return [targetRootSlug, localDir, `${docSlug}.md`].filter(Boolean).join("/");
}

function uniqueDocumentSlug(baseSlug: string, folderPath: string, existingPaths: Set<string>): string {
  let candidate = baseSlug;
  let index = 2;
  while (existingPaths.has([folderPath, `${candidate}.md`].filter(Boolean).join("/"))) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }
  return candidate;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isIgnoredPath(path: string): boolean {
  const parts = normalizePath(path).split("/");
  if (parts.includes(".obsidian") || parts.includes(".trash") || parts.includes(".git")) return true;
  // macOS archive cruft: the __MACOSX sidecar tree, AppleDouble (._name) files, and .DS_Store.
  if (parts.includes("__MACOSX")) return true;
  const base = parts[parts.length - 1] ?? "";
  return base === ".DS_Store" || base.startsWith("._");
}

function normalizeMarkdown(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function dirname(path: string): string {
  const index = normalizePath(path).lastIndexOf("/");
  return index === -1 ? "" : normalizePath(path).slice(0, index);
}

function basename(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() ?? "";
}

function extensionFor(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

// Bulk imports fire one request per folder/document/attachment and can exceed the
// server's per-IP rate limit. Instead of failing the whole import, wait out 429s
// (honoring the "retry in N seconds" hint) and continue.
const MAX_RATE_LIMIT_RETRIES = 6;

function rateLimitDelayMs(error: ApiError): number {
  const message =
    error.body && typeof error.body === "object" && "message" in error.body
      ? String((error.body as { message: unknown }).message)
      : "";
  const seconds = Number(/retry in (\d+)/i.exec(message)?.[1] ?? 10);
  return Math.min(Math.max(seconds, 1), 60) * 1000 + 250;
}

async function withRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs(error)));
        continue;
      }
      throw error;
    }
  }
}

async function uploadAttachmentWithRetry(documentId: string, file: File): Promise<void> {
  try {
    await withRateLimitRetry(() => api.uploadAttachment(documentId, file));
  } catch (firstError) {
    try {
      await withRateLimitRetry(() => api.uploadAttachment(documentId, file));
    } catch {
      throw firstError;
    }
  }
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
  return path === root ? basename(path) : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
