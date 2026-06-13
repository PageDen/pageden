import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Download, FileUp, FolderOpen, Loader2, UploadCloud } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { api, crudErrorMessage } from "../../lib/api";
import { treeQuery } from "../../lib/queries";
import { buildImportReportMarkdown, buildWebImportPreview, filesFromFileList, importFilesToWorkspace, type BrowserImportFile, type ImportConflictPolicy, type ImportProgress, type WebImportPreview, type WebImportReport } from "./vault-import";

export function ImportPage() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const queryClient = useQueryClient();
  const tree = useQuery(treeQuery(workspaceId));
  const [targetRootName, setTargetRootName] = useState("Imported from Web");
  const [files, setFiles] = useState<BrowserImportFile[]>([]);
  const [preview, setPreview] = useState<WebImportPreview | null>(null);
  const [report, setReport] = useState<WebImportReport | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<ImportConflictPolicy>("skip");
  const [isReadingFolder, setIsReadingFolder] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const fileSummary = useMemo(() => {
    const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
    return { count: files.length, totalBytes };
  }, [files]);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!tree.data) throw new Error("Workspace tree is not loaded yet.");
      setProgress({ phase: "documents", current: 0, total: files.length, label: "Preparing import" });
      return importFilesToWorkspace({
        workspaceId,
        files,
        tree: tree.data,
        targetRootName: targetRootName || "Imported from Web",
        conflictPolicy,
        onProgress: setProgress,
      });
    },
    onSuccess: (nextReport) => {
      setReport(nextReport);
      void queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
    },
  });
  // Server-side zip import: upload once, then poll the job. The import keeps running on
  // the server even if this tab closes; large vaults never hit per-request rate limits.
  const serverImportMutation = useMutation({
    mutationFn: async (file: File) => {
      setReport(null);
      setProgress({ phase: "documents", current: 0, total: 100, label: "Uploading zip…" });
      const { jobId } = await api.uploadVaultZip(
        workspaceId,
        file,
        { targetRootName: targetRootName || "Imported from Web", conflictPolicy },
        (pct) => setProgress({ phase: "documents", current: pct, total: 100, label: `Uploading zip (${pct}%)` }),
      );
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await api.importJob(jobId);
        if (job.progress) setProgress(job.progress as ImportProgress);
        if (job.status === "done") return job;
        if (job.status === "failed") throw new Error(job.error ?? "Import failed.");
      }
    },
    onSuccess: (job) => {
      setProgress(null);
      setReport(serverReportToWebReport(job.report, targetRootName || "Imported from Web"));
      void queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
    },
  });

  const isBusy = importMutation.isPending || serverImportMutation.isPending;
  const largeVault = fileSummary.count > 200 || fileSummary.totalBytes > 25 * 1024 * 1024;
  const canImport = Boolean(workspaceId && tree.data && files.length && preview && !isBusy && !isReadingFolder);

  async function updatePreview(nextFiles = files, nextRoot = targetRootName) {
    if (!tree.data || nextFiles.length === 0) {
      setPreview(null);
      return;
    }
    try {
      setPreviewError(null);
      setPreview(await buildWebImportPreview(nextFiles, tree.data, nextRoot));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Could not preview import.");
    }
  }

  async function prepareFiles(nextFiles: BrowserImportFile[], label: string) {
    setSourceLabel(label);
    setFiles(nextFiles);
    setReport(null);
    setProgress(null);
    await updatePreview(nextFiles, targetRootName);
  }

  async function onFilesSelected(selected: FileList | null) {
    const nextFiles = selected ? filesFromFileList(selected) : [];
    await prepareFiles(nextFiles, "Selected folder");
  }

  async function onFolderPickerClick() {
    const directoryPicker = getDirectoryPicker();
    if (directoryPicker) {
      try {
        setIsReadingFolder(true);
        setPreviewError(null);
        const directory = await directoryPicker();
        await prepareFiles(await filesFromDirectoryHandle(directory), directory.name);
      } catch (error) {
        if (!isAbortError(error)) {
          setPreviewError(error instanceof Error ? error.message : "Could not read that folder.");
        }
      } finally {
        setIsReadingFolder(false);
      }
      return;
    }

    folderInputRef.current?.click();
  }

  async function onRootChange(value: string) {
    const next = value.trimStart();
    setTargetRootName(next);
    await updatePreview(files, next || "Imported from Web");
  }

  return (
    <div className="min-h-screen bg-white px-8 py-8 text-slate-950 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-5xl">
        <div className="mb-7 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
            <UploadCloud size={22} aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">Import</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">Import an Obsidian vault</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Choose a local folder of Markdown files. Pageden previews the import, preserves frontmatter, creates matching folders, and skips existing documents.
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-4 flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
              <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">1. Choose vault folder</h2>
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Destination top-level folder</span>
              <Input
                value={targetRootName}
                onChange={(event) => void onRootChange(event.target.value)}
                placeholder="Imported from Web"
              />
            </label>
            <button
              type="button"
              className="mt-4 flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition hover:border-orange-300 hover:bg-orange-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-orange-400/60 dark:hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={importMutation.isPending || isReadingFolder}
              onClick={() => void onFolderPickerClick()}
            >
              <FileUp className="h-8 w-8 text-orange-600 dark:text-orange-300" aria-hidden="true" />
              <span className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">{isReadingFolder ? "Reading folder..." : "Select your vault folder"}</span>
              <span className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Opens a local folder picker and previews files before import.
              </span>
            </button>
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="sr-only"
              disabled={isBusy}
              onChange={(event) => {
                void onFilesSelected(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />

            <button
              type="button"
              className="mt-3 flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center transition hover:border-orange-300 hover:bg-orange-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-orange-400/60 dark:hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isBusy || isReadingFolder}
              onClick={() => zipInputRef.current?.click()}
            >
              <UploadCloud className="h-6 w-6 text-orange-600 dark:text-orange-300" aria-hidden="true" />
              <span className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                {serverImportMutation.isPending ? "Importing on the server…" : "Upload zip (recommended for large vaults)"}
              </span>
              <span className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                Processed on the server — you can close this tab while it runs.
              </span>
            </button>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              disabled={isBusy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) serverImportMutation.mutate(file);
                event.currentTarget.value = "";
              }}
            />
            {largeVault && !serverImportMutation.isPending ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                <span className="font-medium">Large vault detected.</span> For a faster, more reliable import, zip your
                vault folder and use “Upload zip” instead — the server processes it in one job.
              </div>
            ) : null}
            {serverImportMutation.isPending && progress ? (
              <div className="mt-3">
                <ImportProgressBar progress={progress} />
              </div>
            ) : null}
            {serverImportMutation.isError ? (
              <p className="mt-3 text-sm text-red-600 dark:text-red-300">
                {serverImportMutation.error instanceof Error
                  ? serverImportMutation.error.message
                  : crudErrorMessage(serverImportMutation.error)}
              </p>
            ) : null}

            {fileSummary.count ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                {sourceLabel ? `${sourceLabel}: ` : "Selected "}
                {fileSummary.count} file{fileSummary.count === 1 ? "" : "s"} ({formatBytes(fileSummary.totalBytes)}).
              </p>
            ) : null}
            {isReadingFolder ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading selected folder...
              </p>
            ) : null}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-4 flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
              <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">2. Preview and import</h2>
            </div>
            {tree.isLoading ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">Loading workspace...</p>
            ) : tree.isError ? (
              <p className="text-sm text-red-600 dark:text-red-300">Could not load workspace tree.</p>
            ) : preview ? (
              <div className="space-y-3">
                <PreviewRow label="Markdown notes" value={preview.notes} />
                <PreviewRow label="Attachments detected" value={preview.attachments} />
                <PreviewRow label="Notes with frontmatter" value={preview.frontmatter} />
                <PreviewRow label="Skipped internal files" value={preview.skipped} />
                <PreviewRow label="Existing remote documents found" value={preview.conflicts.length} />
                {preview.conflicts.length ? (
                  <fieldset className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                    <legend className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-200">Duplicate paths found</legend>
                    <p className="mt-2 text-sm leading-5 text-amber-800 dark:text-amber-100">
                      These notes match documents that already exist in Pageden. Choose whether to leave the existing document alone or import a copy with a safe new slug.
                    </p>
                    <ul className="mt-2 max-h-24 space-y-1 overflow-auto rounded-md border border-amber-200 bg-white/70 p-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-slate-950/40 dark:text-amber-100">
                      {preview.conflicts.slice(0, 5).map((path) => (
                        <li key={path} className="truncate">{path}</li>
                      ))}
                      {preview.conflicts.length > 5 ? <li>+ {preview.conflicts.length - 5} more</li> : null}
                    </ul>
                    <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <input
                        type="radio"
                        name="conflict-policy"
                        value="skip"
                        checked={conflictPolicy === "skip"}
                        onChange={() => setConflictPolicy("skip")}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium text-slate-800 dark:text-slate-100">Skip it</span>
                        Keep the existing Pageden document unchanged. The import report will list these files as skipped.
                      </span>
                    </label>
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <input
                        type="radio"
                        name="conflict-policy"
                        value="rename"
                        checked={conflictPolicy === "rename"}
                        onChange={() => setConflictPolicy("rename")}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium text-slate-800 dark:text-slate-100">Import as a copy</span>
                        Create a separate document with a new name like <code className="rounded bg-white px-1 dark:bg-slate-800">note-2.md</code>.
                      </span>
                    </label>
                  </fieldset>
                ) : null}
                {preview.attachmentWarnings.length ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                      Attachment links need attention
                    </div>
                    <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-100">
                      Pageden will still import the notes, but these media links may need to be reattached afterward.
                    </p>
                    <ul className="mt-2 max-h-28 list-disc space-y-1 overflow-auto pl-5 text-xs text-amber-800 dark:text-amber-100">
                      {preview.attachmentWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {preview.samplePaths.length ? (
                  <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/40">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Import sample</div>
                    <ul className="mt-2 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                      {preview.samplePaths.map((path) => (
                        <li key={path} className="truncate">{path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {progress ? <ImportProgressBar progress={progress} /> : null}
                <Button className="mt-2 w-full" disabled={!canImport} onClick={() => importMutation.mutate()}>
                  {importMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                  {importMutation.isPending ? "Importing..." : "Import into Pageden"}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-400 dark:text-slate-500">Choose a folder to see what will be imported.</p>
            )}
            {previewError ? <p className="mt-3 text-sm text-red-600 dark:text-red-300">{previewError}</p> : null}
            {importMutation.isError ? <p className="mt-3 text-sm text-red-600 dark:text-red-300">{crudErrorMessage(importMutation.error)}</p> : null}
          </section>
        </div>

        {report ? (
          <section className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-emerald-950 dark:text-emerald-100">Import complete</h2>
              <Button type="button" variant="secondary" onClick={() => downloadImportReport(report)}>
                <Download className="mr-2 h-4 w-4" />
                Download report
              </Button>
            </div>
            <p className="mt-2 text-sm leading-6 text-emerald-800 dark:text-emerald-200">
              Created {report.foldersCreated} folder{report.foldersCreated === 1 ? "" : "s"}, {report.documentsCreated} document{report.documentsCreated === 1 ? "" : "s"}, and uploaded {report.attachmentsUploaded} attachment{report.attachmentsUploaded === 1 ? "" : "s"}.
              {report.documentsSkipped ? ` Skipped ${report.documentsSkipped} existing document${report.documentsSkipped === 1 ? "" : "s"}.` : ""}
            </p>
            {report.attachmentWarnings.length ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                <div className="font-medium">Attachment warnings</div>
                <p className="mt-1 text-xs leading-5">
                  These files were referenced from notes, but Pageden could not upload them. The notes imported successfully; add the missing files manually or re-run the import after fixing paths.
                </p>
                <ul className="mt-2 list-disc pl-5">
                  {report.attachmentWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {report.rows.length ? (
              <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-emerald-200 bg-white dark:border-slate-800 dark:bg-slate-950/50">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-emerald-50 text-xs uppercase tracking-wide text-emerald-700 dark:bg-slate-900 dark:text-emerald-200">
                    <tr>
                      <th className="px-3 py-2 font-semibold">File</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {report.rows.map((row) => (
                      <tr key={`${row.status}:${row.path}:${row.message}`}>
                        <td className="max-w-[240px] truncate px-3 py-2 text-slate-700 dark:text-slate-300">{row.path}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(row.status)}`}>
                            {row.status === "warning" ? <AlertTriangle size={12} /> : null}
                            {row.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{row.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Shape a server-side job report into the WebImportReport the report UI renders. */
function serverReportToWebReport(raw: unknown, targetRootName: string): WebImportReport {
  const r = (raw ?? {}) as Partial<WebImportReport> & { processedPaths?: string[] };
  return {
    targetRootName,
    targetRootSlug: "",
    notes: (r.documentsCreated ?? 0) + (r.documentsSkipped ?? 0),
    attachments: r.attachmentsUploaded ?? 0,
    skipped: 0,
    frontmatter: 0,
    conflicts: [],
    samplePaths: [],
    foldersCreated: r.foldersCreated ?? 0,
    documentsCreated: r.documentsCreated ?? 0,
    documentsSkipped: r.documentsSkipped ?? 0,
    attachmentsUploaded: r.attachmentsUploaded ?? 0,
    attachmentWarnings: r.attachmentWarnings ?? [],
    rows: r.rows ?? [],
  };
}

function ImportProgressBar({ progress }: { progress: ImportProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  return (
    <div className="rounded-lg border border-orange-100 bg-orange-50 p-3 dark:border-orange-500/30 dark:bg-orange-500/10">
      <div className="flex items-center justify-between gap-3 text-xs font-medium text-orange-800 dark:text-orange-200">
        <span className="truncate">{progress.label}</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-orange-100 dark:bg-orange-950/60">
        <div className="h-full rounded-full bg-orange-600 transition-all dark:bg-orange-400" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function statusPillClass(status: WebImportReport["rows"][number]["status"]) {
  if (status === "created") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200";
  if (status === "warning") return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200";
  return "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300";
}

function PreviewRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950/40">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-semibold text-slate-950 dark:text-slate-50">{value}</span>
    </div>
  );
}

function downloadImportReport(report: WebImportReport) {
  const blob = new Blob([buildImportReportMarkdown(report)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pageden-import-report-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type BrowserFileSystemHandle = BrowserFileSystemDirectoryHandle | BrowserFileSystemFileHandle;

interface BrowserFileSystemDirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<BrowserFileSystemHandle>;
}

interface BrowserFileSystemFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: () => Promise<BrowserFileSystemDirectoryHandle>;
};

function getDirectoryPicker() {
  return (window as WindowWithDirectoryPicker).showDirectoryPicker;
}

async function filesFromDirectoryHandle(directory: BrowserFileSystemDirectoryHandle): Promise<BrowserImportFile[]> {
  const files: BrowserImportFile[] = [];

  async function walk(current: BrowserFileSystemDirectoryHandle, segments: string[]) {
    for await (const entry of current.values()) {
      if (entry.kind === "directory") {
        await walk(entry, [...segments, entry.name]);
        continue;
      }
      const file = await entry.getFile();
      const path = [...segments, entry.name].join("/");
      files.push({
        file,
        path,
        originalPath: `${directory.name}/${path}`,
        name: entry.name,
        extension: entry.name.includes(".") ? entry.name.split(".").pop()?.toLowerCase() ?? "" : "",
      });
    }
  }

  await walk(directory, []);
  return files;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
