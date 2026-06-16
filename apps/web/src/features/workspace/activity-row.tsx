import { Link } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  CheckCircle2,
  CircleDashed,
  FileText,
  Hammer,
  MessageSquare,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { z } from "zod";
import type { activityEventSchema } from "@pageden/api-types";
import { documentReadablePath } from "../../lib/document-links";

type Event = z.infer<typeof activityEventSchema>;

// Shared activity-row used by both the workspace dashboard (compact) and the
// full activity page. Keeping the icon/label mapping here so the two views can
// never disagree about what an action is called.
const ICONS: Record<string, LucideIcon> = {
  document_created: Plus,
  document_updated: Pencil,
  document_pushed: Upload,
  document_created_by_agent: Bot,
  document_updated_by_agent: Bot,
  document_appended_by_agent: Bot,
  document_renamed: Pencil,
  document_moved: MoveRight,
  document_deleted: Trash2,
  document_restored: RefreshCw,
  document_read_by_agent: Bot,
  document_marked_canonical: CheckCircle2,
  document_marked_superseded: CircleDashed,
  document_marked_draft: CircleDashed,
  document_marked_archived: Archive,
  comment_added: MessageSquare,
  comment_added_by_agent: MessageSquare,
  comment_resolved: CheckCircle2,
  comment_resolved_by_agent: CheckCircle2,
  comment_deleted: Trash2,
  mcp_tool_called: Hammer,
};

const LABELS: Record<string, string> = {
  document_created: "created",
  document_updated: "updated",
  document_pushed: "pushed (Obsidian)",
  document_created_by_agent: "created (agent)",
  document_updated_by_agent: "updated (agent)",
  document_appended_by_agent: "appended (agent)",
  document_renamed: "renamed",
  document_moved: "moved",
  document_deleted: "deleted",
  document_restored: "restored",
  document_read_by_agent: "read (agent)",
  document_marked_canonical: "marked canonical",
  document_marked_superseded: "marked superseded",
  document_marked_draft: "marked draft",
  document_marked_archived: "marked archived",
  comment_added: "commented",
  comment_added_by_agent: "commented (agent)",
  comment_resolved: "resolved comment",
  comment_resolved_by_agent: "resolved comment (agent)",
  comment_deleted: "deleted comment",
  mcp_tool_called: "MCP tool",
};

const actorTone: Record<Event["actor"], string> = {
  agent: "text-orange-600 dark:text-orange-300",
  user: "text-slate-500 dark:text-slate-400",
  obsidian_plugin: "text-sky-600 dark:text-sky-300",
  system: "text-slate-400 dark:text-slate-500",
  unknown: "text-slate-400 dark:text-slate-500",
};

export function ActivityRow({ event, workspaceId, compact }: { event: Event; workspaceId: string; compact?: boolean }) {
  const Icon = ICONS[event.action] ?? FileText;
  const verb = LABELS[event.action] ?? event.action;
  return (
    <li className={compact ? "flex items-center gap-2 py-1.5" : "flex items-start gap-3 py-3"}>
      <Icon size={compact ? 13 : 15} className={`mt-0.5 shrink-0 ${actorTone[event.actor]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-slate-700 dark:text-slate-300">
          <span className={`font-medium capitalize ${actorTone[event.actor]}`}>{event.actor}</span>{" "}
          <span>{verb}</span>{" "}
          {event.targetId && event.documentTitle ? (
            event.documentTitle ? (
              <Link
                to={event.documentPath ? documentReadablePath(workspaceId, event.documentPath) : `/w/${encodeURIComponent(workspaceId)}/d/${encodeURIComponent(event.targetId)}`}
                className="font-semibold text-slate-900 hover:text-orange-700 dark:text-slate-100 dark:hover:text-orange-300"
              >
                {event.documentTitle}
              </Link>
            ) : (
              <span className="text-slate-500">a deleted document</span>
            )
          ) : (
            <span className="text-slate-500">{event.targetType}</span>
          )}
        </p>
        {!compact && event.documentPath ? <p className="truncate text-xs text-slate-400">{event.documentPath}</p> : null}
      </div>
      <time className="shrink-0 text-xs text-slate-400 dark:text-slate-500" dateTime={event.createdAt}>
        {formatRelative(event.createdAt)}
      </time>
    </li>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
