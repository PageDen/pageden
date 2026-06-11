import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Eye, History, Info, Radio, Save, Sparkles, SquarePen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { previewSanitizeSchema, rehypeAllowlistIframes } from "./media-sanitize";
import type { z } from "zod";
import { attachmentListSchema, documentWithContentSchema, treeSchema } from "@pageden/api-types";
import { api, ApiError, conflictVersion } from "../../lib/api";
import { documentQuery, revisionsQuery, treeQuery } from "../../lib/queries";
import { useDocumentDraft } from "../../lib/draft";
import { Button } from "../../components/ui/button";
import { RichMarkdownEditor } from "./rich-markdown-editor";
import { isAllowedEmbedSrc } from "./media";
import { TableOfContents } from "./table-of-contents";
import { parseFrontmatter } from "./frontmatter";

type Doc = z.infer<typeof documentWithContentSchema>;
type Tree = z.infer<typeof treeSchema>;
type AttachmentList = z.infer<typeof attachmentListSchema>;
const permissionLabel: Record<string, string> = { viewer: "Read-only", editor: "Editor", manager: "Manager" };

export function DocumentEditor({ doc, workspaceId }: { doc: Doc; workspaceId: string }) {
  const queryClient = useQueryClient();
  const canEdit = doc.permission === "editor" || doc.permission === "manager";
  const draft = useDocumentDraft({ content: doc.content, version: doc.version ?? "" });
  const [preview, setPreview] = useState(false);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [conflict, setConflict] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const tree = useQuery({ ...treeQuery(workspaceId), enabled: preview || !canEdit });
  const attachments = useQuery({
    queryKey: ["attachments", doc.id],
    queryFn: () => api.attachments(doc.id),
    enabled: preview || !canEdit,
  });
  const parsedPreview = useMemo(() => parseFrontmatter(canEdit ? draft.content : doc.content), [canEdit, doc.content, draft.content]);
  const previewContent = useMemo(
    () => resolveWikiLinks(parsedPreview.body, workspaceId, tree.data),
    [parsedPreview.body, tree.data, workspaceId],
  );
  const attachmentUrls = useMemo(() => buildAttachmentUrlMap(attachments.data), [attachments.data]);
  const liveConfig = useMemo(
    () =>
      live && canEdit
        ? {
            websocketUrl: api.liveBaseUrl(),
            documentId: doc.id,
            onStatus: setLiveStatus,
          }
        : undefined,
    [canEdit, doc.id, live],
  );

  // Guard against losing unsaved edits on navigation / tab close.
  useBlocker({
    shouldBlockFn: () => draft.dirty && !window.confirm("You have unsaved changes. Leave and discard them?"),
    enableBeforeUnload: () => draft.dirty,
  });

  const save = useMutation({
    // Capture the exact base + content sent so success commits against THIS payload.
    mutationFn: (vars: { baseVersion: string; content: string }) => api.updateDocument(doc.id, vars),
    onSuccess: (result, vars) => {
      setConflict(null);
      draft.commit(result.version, vars.content); // advances base; never clobbers newer edits
      queryClient.setQueryData(documentQuery(doc.id).queryKey, (old: Doc | undefined) => ({
        ...(old ?? doc),
        content: vars.content,
        version: result.version,
        checksum: result.checksum,
        updatedAt: result.updatedAt,
      }));
      void queryClient.invalidateQueries({ queryKey: documentQuery(doc.id).queryKey });
      void queryClient.invalidateQueries({ queryKey: revisionsQuery(doc.id).queryKey });
      void queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
    },
    onError: (error) => {
      const cv = conflictVersion(error);
      if (cv) setConflict(cv);
    },
  });

  async function saveWithRetry(): Promise<void> {
    const content = draft.canonical();
    try {
      await save.mutateAsync({ baseVersion: draft.getBaseVersion(), content });
    } catch (error) {
      const cv = conflictVersion(error);
      if (!live || !cv) throw error;
      const fresh = await api.document(doc.id);
      draft.commit(fresh.version ?? "", fresh.content);
      await save.mutateAsync({ baseVersion: fresh.version ?? "", content: draft.canonical() });
      setConflict(null);
    }
  }

  function doSave() {
    void saveWithRetry();
  }

  useEffect(() => {
    if (!live || !canEdit || !draft.dirty || save.isPending || reloading) return;
    const id = window.setTimeout(() => void saveWithRetry(), 1500);
    return () => window.clearTimeout(id);
  }, [canEdit, draft.content, draft.dirty, live, reloading, save.isPending]);

  async function reloadServerVersion() {
    setReloading(true);
    try {
      const fresh = await api.document(doc.id); // force network, not cache
      queryClient.setQueryData(documentQuery(doc.id).queryKey, fresh);
      draft.reset({ content: fresh.content, version: fresh.version ?? "" });
      setConflict(null);
    } finally {
      setReloading(false);
    }
  }

  function copyDraft() {
    void navigator.clipboard?.writeText(draft.content);
  }
  function downloadDraft() {
    const blob = new Blob([draft.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.path.split("/").pop() || "document.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Rescue controls offered on ANY failed save so the buffer is never a dead end.
  const rescue = (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="ghost" onClick={copyDraft}>Copy my draft</Button>
      <Button variant="ghost" onClick={downloadDraft}>Download my draft</Button>
    </div>
  );

  const saveError = save.error;
  const nonConflictMessage =
    saveError && !conflict
      ? saveError instanceof ApiError && (saveError.status === 403 || saveError.status === 404)
        ? "You no longer have permission to edit this document."
        : "Could not save. Your text is safe — copy or download it below."
      : null;

  return (
    <article className="flex h-screen flex-col bg-white">
      <header className="border-b border-slate-200 px-8 py-4">
        <div className="mx-auto flex max-w-[920px] items-start justify-between gap-6">
          <div className="min-w-0 pt-0.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-950">{doc.title}</h1>
            <p className="mt-1 truncate text-xs text-slate-400">{doc.path}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <AiReadinessBadge readiness={doc.aiReadiness} />
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {permissionLabel[doc.permission] ?? doc.permission}
            </span>
            {canEdit ? (
              <Button variant="ghost" className="h-9 gap-1.5 px-2.5" onClick={() => setPreview((p) => !p)}>
                {preview ? <SquarePen size={15} /> : <Eye size={15} />}
                {preview ? "Edit" : "Preview"}
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant={live ? "primary" : "ghost"} className="h-9 gap-1.5 px-2.5" onClick={() => setLive((enabled) => !enabled)}>
                <Radio size={15} />
                {live ? `Live ${liveStatus === "connected" ? "on" : "connecting"}` : "Live"}
              </Button>
            ) : null}
            <Link
              to="/w/$workspaceId/d/$documentId/history"
              params={{ workspaceId, documentId: doc.id }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              <History size={15} />
              History
            </Link>
            {canEdit ? (
              <Button className="h-9 gap-1.5 px-3" onClick={doSave} disabled={!draft.dirty || save.isPending || reloading}>
                <Save size={15} />
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {conflict ? (
        <div className="mx-6 mb-3 mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-800">
            This document changed on the server (now {conflict}). Your edits are kept here — nothing was overwritten.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void reloadServerVersion()} disabled={reloading}>
              {reloading ? "Reloading…" : "Reload server version (discard mine)"}
            </Button>
            <Button variant="ghost" onClick={copyDraft}>Copy my draft</Button>
            <Button variant="ghost" onClick={downloadDraft}>Download my draft</Button>
          </div>
        </div>
      ) : null}
      {nonConflictMessage ? (
        <div className="mx-6 mb-3 mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {nonConflictMessage}
          {rescue}
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto border-r border-slate-200 bg-white">
          {!canEdit || preview ? (
            <div className="mx-auto max-w-[920px] px-8 py-7">
              <div className="prose prose-slate max-w-none break-words text-[15px] leading-7">
                <FrontmatterSummary attributes={parsedPreview.attributes} />
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSanitizeSchema], rehypeAllowlistIframes]}
                  components={{
                    a: ({ href, children, ...props }) => {
                      const resolved = href ? attachmentUrls.get(cleanAttachmentHref(href)) : undefined;
                      return <a {...props} href={resolved ?? href}>{children}</a>;
                    },
                    img: ({ src, alt, ...props }) => {
                      const resolved = src ? attachmentUrls.get(cleanAttachmentHref(src)) : undefined;
                      return <img {...props} src={resolved ?? src} alt={alt ?? ""} className="max-w-full rounded" />;
                    },
                    video: ({ ...props }) => (
                      <video {...props} controls className="max-w-full rounded" />
                    ),
                    iframe: ({ src, ...props }) =>
                      src && isAllowedEmbedSrc(src) ? (
                        <span className="block aspect-video w-full max-w-2xl overflow-hidden rounded">
                          <iframe {...props} src={src} className="h-full w-full" allowFullScreen title="Embedded media" />
                        </span>
                      ) : null,
                  }}
                >
                  {previewContent}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <RichMarkdownEditor documentId={doc.id} value={draft.content} onChange={draft.setContent} live={liveConfig} />
          )}
        </div>
        {!canEdit || preview ? <DocumentInsightsPanel content={previewContent} readiness={doc.aiReadiness} /> : null}
      </div>
    </article>
  );
}

function AiReadinessBadge({ readiness }: { readiness: Doc["aiReadiness"] }) {
  const label = readiness.status === "needs_attention" ? "Needs work" : readiness.status === "usable" ? "Usable" : "Ready";
  const classes =
    readiness.status === "needs_attention"
      ? "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/30"
      : readiness.status === "usable"
        ? "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-400/30"
        : "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-400/30";

  return (
    <span
      className={`inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ring-1 ${classes}`}
      title={`${readiness.score}/100 agent readiness`}
    >
      <Sparkles size={14} />
      AI {label}
    </span>
  );
}

function DocumentInsightsPanel({ content, readiness }: { content: string; readiness: Doc["aiReadiness"] }) {
  return (
    <aside className="hidden w-64 flex-shrink-0 overflow-auto border-l border-slate-200 bg-slate-50 px-4 py-6 dark:border-slate-800 dark:bg-slate-950 lg:block">
      <AiReadinessPanel readiness={readiness} />
      <div className="mt-7 border-t border-slate-200 pt-5 dark:border-slate-800">
        <TableOfContents content={content} embedded />
      </div>
    </aside>
  );
}

function AiReadinessPanel({ readiness }: { readiness: Doc["aiReadiness"] }) {
  const icon =
    readiness.status === "needs_attention" ? (
      <AlertTriangle size={16} className="text-amber-500" />
    ) : readiness.status === "usable" ? (
      <Info size={16} className="text-sky-500" />
    ) : (
      <CheckCircle2 size={16} className="text-emerald-500" />
    );
  const title =
    readiness.status === "needs_attention"
      ? "Needs attention"
      : readiness.status === "usable"
        ? "Usable by agents"
        : "Ready for agents";

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">AI readiness</h2>
          <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {icon}
            {title}
          </div>
        </div>
        <div className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {readiness.score}
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
        Checks that help Codex, Claude, and other agents read this page safely.
      </p>
      {readiness.issues.length === 0 ? (
        <p className="mt-3 rounded-md bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200">
          No obvious issues found.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {readiness.issues.map((issue) => (
            <li
              key={`${issue.code}-${issue.message}`}
              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
            >
              <span className={issue.severity === "warning" ? "font-semibold text-amber-700 dark:text-amber-200" : "font-semibold text-sky-700 dark:text-sky-200"}>
                {issue.severity === "warning" ? "Fix: " : "Note: "}
              </span>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FrontmatterSummary({ attributes }: { attributes: Record<string, string | string[] | boolean | number> }) {
  const entries = Object.entries(attributes).filter(([key]) => key !== "title");
  if (entries.length === 0) return null;
  return (
    <dl className="mb-6 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{key}</dt>
          <dd className="mt-0.5 truncate text-slate-700">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function resolveWikiLinks(content: string, workspaceId: string, tree?: Pick<Tree, "documents">): string {
  const docs = tree?.documents ?? [];
  return content
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?]]/g, (_match, rawTarget: string, rawLabel?: string) => {
      const target = rawTarget.trim();
      const label = (rawLabel ?? target).trim();
      return `![${label}](${target})`;
    })
    .replace(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?]]/g, (_match, rawTarget: string, rawLabel?: string) => {
      const target = rawTarget.trim();
      const label = (rawLabel ?? target).trim();
      const doc = docs.find((d) => d.title === target || d.path.replace(/^\/+/, "") === target.replace(/^\/+/, ""));
      if (!doc) return label;
      return `[${label}](/w/${encodeURIComponent(workspaceId)}/d/${encodeURIComponent(doc.id)})`;
    });
}

function buildAttachmentUrlMap(data?: AttachmentList): Map<string, string> {
  const out = new Map<string, string>();
  for (const attachment of data?.attachments ?? []) {
    const url = api.attachmentUrl(attachment.id);
    out.set(attachment.filename, url);
    out.set(encodeURI(attachment.filename), url);
  }
  return out;
}

function cleanAttachmentHref(href: string): string {
  const withoutHash = href.split("#")[0] ?? href;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  const filename = withoutQuery.split("/").pop() ?? withoutQuery;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}
