import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Check, ChevronDown, Clipboard, Download, FileClock, RotateCcw, Sparkles, Star, Tag } from "lucide-react";
import type { CollapsedRevisionSummary, DocumentHistoryItem, RevisionSummary } from "@pageden/api-types";
import { documentHistoryQuery, documentQuery, meQuery, revisionDetailQuery } from "../../lib/queries";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { documentReadablePath } from "../../lib/document-links";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { track } from "../../lib/analytics-bus";
import { DocumentMarkdownPreview } from "./document-markdown-preview";

type HistoryEntry = (RevisionSummary | CollapsedRevisionSummary) & { groupCount?: number };
type ViewMode = "preview" | "changes";

const sourceLabel: Record<string, string> = {
  web_app: "Web",
  obsidian_plugin: "Obsidian",
  agent: "Agent",
  import: "Import",
  system: "System",
};

export function RevisionHistory() {
  const params = useParams({ strict: false });
  const documentId = params.documentId ?? "";
  const workspaceId = params.workspaceId ?? "";
  const history = useQuery({ ...documentHistoryQuery(documentId), enabled: documentId !== "" });
  const doc = useQuery({ ...documentQuery(documentId), enabled: documentId !== "" });
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = doc.data?.permission === "manager";
  const workspaceName = me.data?.workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<ViewMode>("preview");
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [labelTarget, setLabelTarget] = useState<HistoryEntry | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [copied, setCopied] = useState(false);
  usePageTitle(pageTitle("History", doc.data?.title, workspaceName));

  const entries = useMemo(() => flattenHistory(history.data?.revisions ?? [], expandedGroups), [expandedGroups, history.data?.revisions]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;
  const selectedDetail = useQuery({
    ...revisionDetailQuery(documentId, selected?.id ?? ""),
    enabled: documentId !== "" && Boolean(selected?.id),
  });
  const previousOlder = useMemo(() => {
    if (!selected) return null;
    return [...entries]
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .find((entry) => entry.versionNumber < selected.versionNumber) ?? null;
  }, [entries, selected]);
  const previousDetail = useQuery({
    ...revisionDetailQuery(documentId, previousOlder?.id ?? ""),
    enabled: mode === "changes" && documentId !== "" && Boolean(previousOlder?.id),
  });

  useEffect(() => {
    if (!selectedId && entries.length > 0) setSelectedId(entries[0]!.id);
  }, [entries, selectedId]);

  const restore = useMutation({
    mutationFn: (revisionId: string) => api.restoreRevision(documentId, revisionId),
    onSuccess: (_data, revisionId) => {
      queryClient.removeQueries({ queryKey: documentQuery(documentId).queryKey });
      queryClient.removeQueries({ queryKey: documentHistoryQuery(documentId).queryKey });
      track("document_restored", { doc_id: documentId, revision_id: revisionId });
      void navigate({ to: doc.data?.path ? documentReadablePath(workspaceId, doc.data.path) : `/w/${encodeURIComponent(workspaceId)}/d/${encodeURIComponent(documentId)}` });
    },
  });
  const metadata = useMutation({
    mutationFn: (vars: { revisionId: string; label?: string | null; isPinned?: boolean }) =>
      api.updateRevisionMetadata(documentId, vars.revisionId, { label: vars.label, isPinned: vars.isPinned }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: documentHistoryQuery(documentId).queryKey });
      setLabelTarget(null);
      setLabelDraft("");
    },
  });

  function toggleGroup(groupId: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function copySelected() {
    const content = selectedDetail.data?.revision.content;
    if (!content) return;
    await copyTextToClipboard(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadSelected() {
    const detail = selectedDetail.data;
    if (!detail) return;
    const blob = new Blob([detail.revision.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFilename(detail.document.currentTitle)}-v${detail.revision.versionNumber}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const selectedContent = selectedDetail.data?.revision.content ?? "";
  const previousContent = previousDetail.data?.revision.content ?? "";
  const diff = useMemo(() => diffLines(previousContent, selectedContent), [previousContent, selectedContent]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white px-4 py-4 dark:border-slate-800 dark:bg-slate-950 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">History</p>
            <h1 className="truncate text-2xl font-semibold">{doc.data?.title ?? "Document history"}</h1>
            <p className="truncate text-sm text-slate-500 dark:text-slate-400">{doc.data?.path}</p>
          </div>
          <Link
            to={doc.data?.path ? documentReadablePath(workspaceId, doc.data.path) : `/w/${encodeURIComponent(workspaceId)}/d/${encodeURIComponent(documentId)}`}
            className="text-sm font-medium text-orange-700 underline decoration-orange-300 underline-offset-4 hover:text-orange-800 dark:text-orange-300"
          >
            Back to document
          </Link>
        </div>
      </header>

      {history.isLoading || doc.isLoading ? (
        <CenteredMessage>Loading history...</CenteredMessage>
      ) : history.isError || doc.isError ? (
        <CenteredMessage>
          {history.error instanceof ApiError && history.error.status === 404
            ? "This document was not found, or you don't have access to it."
            : "Could not load history."}
        </CenteredMessage>
      ) : entries.length === 0 ? (
        <CenteredMessage>No revisions yet.</CenteredMessage>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 lg:border-b-0 lg:border-r">
            <div className="space-y-2 p-3">
              {history.data!.timeline.map((item) =>
                item.type === "revision" ? (
                  <RevisionTimelineBlock
                    key={item.id}
                    revision={item.revision}
                    selectedId={selected?.id ?? null}
                    expanded={expandedGroups.has(item.revision.groupId)}
                    onSelect={setSelectedId}
                    onToggleGroup={item.revision.groupCount > 1 ? () => toggleGroup(item.revision.groupId) : undefined}
                  />
                ) : (
                  <TimelineEventRow key={item.id} item={item} />
                ),
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-auto">
            <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8">
              <div className="mb-4 flex flex-col gap-3 border-b border-slate-200 pb-4 dark:border-slate-800 xl:flex-row xl:items-center xl:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{selected ? `Version ${selected.versionNumber}` : "Select a version"}</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {selected ? `${sourceLabel[selected.changeSource] ?? selected.changeSource} · ${formatDateTime(selected.createdAt)}` : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
                    <button
                      type="button"
                      className={modeButtonClass(mode === "preview")}
                      onClick={() => setMode("preview")}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className={modeButtonClass(mode === "changes")}
                      onClick={() => setMode("changes")}
                    >
                      Changes
                    </button>
                  </div>
                  <IconButton label={copied ? "Copied" : "Copy Markdown"} onClick={() => void copySelected()} disabled={!selectedDetail.data}>
                    {copied ? <Check size={16} /> : <Clipboard size={16} />}
                  </IconButton>
                  <IconButton label="Download Markdown" onClick={downloadSelected} disabled={!selectedDetail.data}>
                    <Download size={16} />
                  </IconButton>
                  {canManage && selected ? (
                    <>
                      <IconButton
                        label={selected.isPinned ? "Unpin" : "Pin"}
                        onClick={() => metadata.mutate({ revisionId: selected.id, isPinned: !selected.isPinned })}
                        disabled={metadata.isPending}
                      >
                        <Star size={16} className={selected.isPinned ? "fill-current" : ""} />
                      </IconButton>
                      <IconButton
                        label={selected.label ? "Rename label" : "Name revision"}
                        onClick={() => {
                          setLabelTarget(selected);
                          setLabelDraft(selected.label ?? "");
                        }}
                        disabled={metadata.isPending}
                      >
                        <Tag size={16} />
                      </IconButton>
                    </>
                  ) : null}
                  {canManage && selected && selected.id !== doc.data?.version ? (
                    <Button variant="danger" onClick={() => setConfirmRestore(true)} disabled={restore.isPending}>
                      <RotateCcw size={16} />
                      Restore this version
                    </Button>
                  ) : null}
                </div>
              </div>

              {selectedDetail.isLoading ? (
                <p className="text-sm text-slate-500">Loading preview...</p>
              ) : selectedDetail.isError ? (
                <p className="text-sm text-red-600">Could not load this version.</p>
              ) : mode === "preview" ? (
                <DocumentMarkdownPreview
                  content={selectedContent}
                  documentId={documentId}
                  workspaceId={workspaceId}
                  className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-7"
                />
              ) : previousOlder ? (
                <DiffView loading={previousDetail.isLoading} lines={diff} previousVersion={previousOlder.versionNumber} selectedVersion={selected?.versionNumber ?? 0} />
              ) : (
                <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
                  This is the first saved version, so there is no older version to compare.
                </p>
              )}
            </div>
          </section>
        </main>
      )}

      {confirmRestore && selected ? (
        <Dialog title={`Restore version ${selected.versionNumber}?`} onClose={() => setConfirmRestore(false)} size="lg">
          <p className="text-sm leading-6 text-slate-600">
            Restoring creates a new version from this snapshot. The current document and all older history stay available.
          </p>
          {restore.isError ? <p className="mt-2 text-sm text-red-600">Could not restore this version.</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmRestore(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => restore.mutate(selected.id)} disabled={restore.isPending}>
              {restore.isPending ? "Restoring..." : "Restore version"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {labelTarget ? (
        <Dialog title={`Name version ${labelTarget.versionNumber}`} onClose={() => setLabelTarget(null)} size="lg">
          <label className="block space-y-2 text-sm">
            <span className="font-medium text-slate-700 dark:text-slate-200">Label</span>
            <input
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              maxLength={80}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-orange-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              autoFocus
            />
          </label>
          {metadata.isError ? <p className="mt-2 text-sm text-red-600">Could not save this label.</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLabelTarget(null)}>Cancel</Button>
            <Button
              onClick={() => metadata.mutate({ revisionId: labelTarget.id, label: labelDraft.trim() || null })}
              disabled={metadata.isPending}
            >
              {metadata.isPending ? "Saving..." : "Save label"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function RevisionTimelineBlock({
  revision,
  selectedId,
  expanded,
  onSelect,
  onToggleGroup,
}: {
  revision: RevisionSummary;
  selectedId: string | null;
  expanded: boolean;
  onSelect: (id: string) => void;
  onToggleGroup?: () => void;
}) {
  return (
    <div>
      <HistoryRow
        revision={revision}
        selected={selectedId === revision.id}
        onSelect={() => onSelect(revision.id)}
        onToggleGroup={onToggleGroup}
        expanded={expanded}
      />
      {expanded ? (
        <div className="ml-4 mt-1 space-y-1 border-l border-slate-200 pl-2 dark:border-slate-800">
          {revision.collapsedRevisions.map((collapsed) => (
            <HistoryRow
              key={collapsed.id}
              revision={collapsed}
              selected={selectedId === collapsed.id}
              onSelect={() => onSelect(collapsed.id)}
              compact
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TimelineEventRow({ item }: { item: Extract<DocumentHistoryItem, { type: "event" }> }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-transparent px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
      <FileClock size={14} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{eventLabel(item.event.action, item.event.actor)}</span>
      <span className="shrink-0">{formatDateTime(item.createdAt)}</span>
    </div>
  );
}

function HistoryRow({
  revision,
  selected,
  onSelect,
  onToggleGroup,
  expanded = false,
  compact = false,
}: {
  revision: HistoryEntry;
  selected: boolean;
  onSelect: () => void;
  onToggleGroup?: () => void;
  expanded?: boolean;
  compact?: boolean;
}) {
  const groupCount = "groupCount" in revision ? revision.groupCount ?? 1 : 1;
  return (
    <div
      className={[
        "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition",
        selected
          ? "border-orange-300 bg-orange-50 text-slate-950 dark:border-orange-500/60 dark:bg-orange-500/10 dark:text-slate-50"
          : "border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-800 dark:hover:bg-slate-900",
        compact ? "py-1.5 text-xs" : "",
      ].join(" ")}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <span className="block font-semibold">Version {revision.versionNumber}</span>
        {revision.label ? (
          <span className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <Tag size={10} aria-hidden="true" />
            {revision.label}
          </span>
        ) : null}
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          {sourceLabel[revision.changeSource] ?? revision.changeSource} · {formatDateTime(revision.createdAt)}
        </span>
        {revision.contributorIds.length > 1 ? (
          <span className="block truncate text-[11px] text-slate-400">{revision.contributorIds.length} contributors</span>
        ) : null}
      </button>
      {revision.isPinned ? <Sparkles size={15} className="shrink-0 text-amber-500" aria-label="Pinned revision" /> : null}
      {groupCount > 1 && onToggleGroup ? (
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          onClick={onToggleGroup}
          title={expanded ? "Collapse save burst" : "Show save burst"}
        >
          {groupCount} saves
          <ChevronDown size={14} className={expanded ? "rotate-180 transition" : "transition"} />
        </button>
      ) : null}
    </div>
  );
}

function eventLabel(action: string, actor: string): string {
  const who = actor === "obsidian_plugin" ? "Obsidian" : actor === "agent" ? "Agent" : actor === "system" ? "System" : "User";
  const labels: Record<string, string> = {
    document_created: `${who} created document`,
    document_updated: `${who} edited document`,
    document_pushed: "Obsidian pushed changes",
    document_renamed: `${who} renamed document`,
    document_moved: `${who} moved document`,
    document_restored: `${who} restored a version`,
    document_created_by_agent: "Agent created document",
    document_updated_by_agent: "Agent edited document",
    document_appended_by_agent: "Agent appended content",
    document_revision_metadata_updated: `${who} updated version metadata`,
  };
  return labels[action] ?? action;
}

function DiffView({ loading, lines, previousVersion, selectedVersion }: { loading: boolean; lines: DiffLine[]; previousVersion: number; selectedVersion: number }) {
  if (loading) return <p className="text-sm text-slate-500">Loading comparison...</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
        Comparing version {selectedVersion} with previous version {previousVersion}
      </div>
      <div className="overflow-x-auto">
        <pre className="min-w-full whitespace-pre-wrap break-words p-0 font-mono text-sm leading-6">
          {lines.map((line, index) => (
            <div key={`${line.kind}-${index}`} className={diffLineClass(line.kind)}>
              <span className="mr-3 inline-block w-5 select-none text-slate-400">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
              <span>{line.text || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return <div className="p-8 text-sm text-slate-500">{children}</div>;
}

function flattenHistory(revisions: RevisionSummary[], expandedGroups: Set<string>): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const revision of revisions) {
    out.push(revision);
    if (expandedGroups.has(revision.groupId)) out.push(...revision.collapsedRevisions);
  }
  return out;
}

function modeButtonClass(active: boolean) {
  return [
    "rounded px-3 py-1.5 text-sm font-medium transition",
    active ? "bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  ].join(" ");
}

type DiffLine = { kind: "same" | "add" | "remove"; text: string };

function diffLines(previous: string, next: string): DiffLine[] {
  const a = previous.split("\n");
  const b = next.split("\n");
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "remove", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "remove", text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "add", text: b[j]! });
    j += 1;
  }
  return out;
}

function diffLineClass(kind: DiffLine["kind"]) {
  if (kind === "add") return "bg-emerald-50 px-4 py-0.5 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100";
  if (kind === "remove") return "bg-red-50 px-4 py-0.5 text-red-900 line-through dark:bg-red-500/10 dark:text-red-100";
  return "px-4 py-0.5 text-slate-700 dark:text-slate-200";
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function safeFilename(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}
