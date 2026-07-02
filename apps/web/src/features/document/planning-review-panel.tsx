import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleDashed, FileDiff, GitPullRequestDraft, MessageSquare, RadioTower, ShieldCheck } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { z } from "zod";
import type { handoffPacketSchema } from "@pageden/api-types";
import { api, crudErrorMessage } from "../../lib/api";
import { documentDiffQuery, documentHandoffQuery, documentHistoryQuery, documentQuery, revisionsQuery, treeQuery } from "../../lib/queries";
import { formatDateTime } from "../../lib/format";
import { Button } from "../../components/ui/button";

type Handoff = z.infer<typeof handoffPacketSchema>;
type Packet = Handoff["packet"];
type RecommendedAction = NonNullable<Packet["recommendedAction"]>;
type WorkflowStatus = "drafting" | "review" | "revision" | "final-review" | "accepted" | "deferred";
type DocumentHistory = Awaited<ReturnType<typeof api.documentHistory>>;
type RevisionEntry = DocumentHistory["revisions"][number] | DocumentHistory["revisions"][number]["collapsedRevisions"][number];
type TimelineItem = DocumentHistory["timeline"][number];
type ReviewActivityItem = TimelineItem & { count?: number };
type DocumentDiff = Awaited<ReturnType<typeof api.documentDiff>>;

const actionLabel: Record<RecommendedAction, string> = {
  comment_only: "Comment only",
  revise: "Revise",
  safe_edit: "Safe edit",
  finalize: "Finalize",
  human_review: "Human review",
};

const workflowLabel: Record<string, string> = {
  drafting: "Drafting",
  review: "Review",
  revision: "Revision",
  "final-review": "Final review",
  accepted: "Accepted",
  deferred: "Deferred",
};

export function PlanningReviewPanel({
  documentId,
  workspaceId,
  enabled,
  canEdit,
  content,
  baseVersion,
  documentStatus,
  hasUnsavedChanges,
}: {
  documentId: string;
  workspaceId: string;
  enabled: boolean;
  canEdit: boolean;
  content: string;
  baseVersion: string;
  documentStatus: "canonical" | "draft" | "superseded" | "archived";
  hasUnsavedChanges: boolean;
}) {
  const handoff = useQuery({ ...documentHandoffQuery(documentId), enabled: enabled && documentId !== "" });

  if (!enabled) return null;
  if (handoff.isLoading) {
    return (
      <PanelShell count={null}>
        <p className="text-xs text-slate-400">Loading planning review...</p>
      </PanelShell>
    );
  }
  if (handoff.isError || !handoff.data?.packet.workflow) {
    return null;
  }

  return (
    <PlanningReviewContent
      packet={handoff.data.packet}
      documentId={documentId}
      workspaceId={workspaceId}
      canEdit={canEdit}
      content={content}
      baseVersion={baseVersion}
      documentStatus={documentStatus}
      hasUnsavedChanges={hasUnsavedChanges}
    />
  );
}

function PlanningReviewContent({
  packet,
  documentId,
  workspaceId,
  canEdit,
  content,
  baseVersion,
  documentStatus,
  hasUnsavedChanges,
}: {
  packet: Packet;
  documentId: string;
  workspaceId: string;
  canEdit: boolean;
  content: string;
  baseVersion: string;
  documentStatus: "canonical" | "draft" | "superseded" | "archived";
  hasUnsavedChanges: boolean;
}) {
  const queryClient = useQueryClient();
  const history = useQuery({ ...documentHistoryQuery(documentId), enabled: documentId !== "" });
  const workflow = packet.workflow;
  if (!workflow) return null;

  const openCommentCount = packet.openCommentsBySection.reduce((sum, group) => sum + group.count, 0);
  const acceptedDecision = packet.decisions.find((decision) => decision.status.toLowerCase() === "accepted");
  const hasAcceptanceCriteria = packet.acceptanceCriteria.length > 0;
  const hasBlockingQuestions = packet.openQuestions.some((question) => /\b(blocking|blocked|must|before final)\b/i.test(question));
  const readyForAcceptedDecision = openCommentCount === 0 && packet.openQuestions.length === 0 && hasAcceptanceCriteria;
  const readyToFinalize =
    packet.recommendedAction === "finalize" &&
    openCommentCount === 0 &&
    packet.openQuestions.length === 0 &&
    hasAcceptanceCriteria &&
    Boolean(acceptedDecision);
  const currentStatus = workflow.workflowStatus as WorkflowStatus | null;
  const revisionEntries = useMemo(() => flattenRevisions(history.data?.revisions ?? []), [history.data?.revisions]);
  const latestRevision = revisionEntries[0] ?? null;
  const previousRevision = latestRevision ? revisionEntries.find((revision) => revision.versionNumber < latestRevision.versionNumber) ?? null : null;
  const latestDiff = useQuery({
    ...documentDiffQuery(documentId, previousRevision?.id ?? "", latestRevision?.id ?? ""),
    enabled: documentId !== "" && Boolean(previousRevision?.id && latestRevision?.id),
  });
  const reviewEvents = useMemo(() => reviewActivityEvents(history.data?.timeline ?? []), [history.data?.timeline]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: documentQuery(documentId).queryKey }),
      queryClient.invalidateQueries({ queryKey: documentHandoffQuery(documentId).queryKey }),
      queryClient.invalidateQueries({ queryKey: documentHistoryQuery(documentId).queryKey }),
      queryClient.invalidateQueries({ queryKey: revisionsQuery(documentId).queryKey }),
      queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey }),
    ]);
  };

  const transition = useMutation({
    mutationFn: async (nextStatus: WorkflowStatus) => {
      const nextRound = nextReviewRound(currentStatus, nextStatus, workflow.reviewRound);
      const nextContent = updatePlanningWorkflowFrontmatter(content, nextStatus, nextRound);
      return api.updateDocument(documentId, {
        baseVersion,
        content: nextContent,
        allowDraft: documentStatus === "draft",
      });
    },
    onSuccess: () => void refresh(),
  });

  const addDecision = useMutation({
    mutationFn: () =>
      api.addDecision(documentId, {
        baseVersion,
        id: "final-plan",
        status: "accepted",
        owner: workflow.leadAgent ?? "human",
        decision: "This plan is accepted as the current source of truth.",
        reason: "Review comments were resolved and remaining open questions were handled or deferred.",
        allowDraft: documentStatus === "draft",
      }),
    onSuccess: () => void refresh(),
  });

  const finalize = useMutation({
    mutationFn: () => api.markDocumentCanonical(documentId),
    onSuccess: () => void refresh(),
  });

  const actionDisabled = !canEdit || hasUnsavedChanges || transition.isPending || addDecision.isPending || finalize.isPending;
  const actions = workflowActionsFor(currentStatus);

  return (
    <PanelShell count={openCommentCount}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Status" value={workflow.workflowStatus ? workflowLabel[workflow.workflowStatus] ?? workflow.workflowStatus : "Unset"} />
          <Metric label="Round" value={workflow.reviewRound === null ? "Unset" : String(workflow.reviewRound)} />
          <Metric label="Lead" value={workflow.leadAgent ?? "Unset"} />
          <Metric label="Reviewer" value={workflow.reviewAgent ?? "Unset"} />
        </div>

        {packet.recommendedAction ? (
          <div className="rounded-md border border-orange-200 bg-orange-50 px-2.5 py-2 text-xs text-orange-900 dark:border-orange-400/30 dark:bg-orange-500/10 dark:text-orange-100">
            <div className="flex items-center gap-1.5 font-semibold">
              <RadioTower size={13} aria-hidden="true" />
              {actionLabel[packet.recommendedAction]}
            </div>
            <div className="mt-1 leading-5">{actionDescription(packet.recommendedAction)}</div>
          </div>
        ) : null}

        {packet.activeClaim ? (
          <div className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-2 text-xs text-sky-900 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100">
            <div className="font-semibold">{packet.activeClaim.actorLabel ?? "Active claim"}</div>
            {packet.activeClaim.note ? <div className="mt-1 leading-5">{packet.activeClaim.note}</div> : null}
          </div>
        ) : null}

        <ReadinessChecklist
          openCommentCount={openCommentCount}
          openQuestionCount={packet.openQuestions.length}
          hasBlockingQuestions={hasBlockingQuestions}
          hasAcceptanceCriteria={hasAcceptanceCriteria}
          hasAcceptedDecision={Boolean(acceptedDecision)}
          readyToFinalize={readyToFinalize}
        />

        {canEdit ? (
          <WorkflowActions
            actions={actions}
            disabled={actionDisabled}
            hasUnsavedChanges={hasUnsavedChanges}
            currentStatus={currentStatus}
            hasAcceptedDecision={Boolean(acceptedDecision)}
            readyForAcceptedDecision={readyForAcceptedDecision}
            readyToFinalize={readyToFinalize}
            addingDecision={addDecision.isPending}
            finalizing={finalize.isPending}
            transitioning={transition.isPending}
            transitionError={transition.error}
            addDecisionError={addDecision.error}
            finalizeError={finalize.error}
            onTransition={(status) => transition.mutate(status)}
            onAddDecision={() => addDecision.mutate()}
            onFinalize={() => finalize.mutate()}
          />
        ) : null}

        <LatestChanges
          loading={history.isLoading || latestDiff.isLoading}
          diff={latestDiff.data}
          latestVersionNumber={latestRevision?.versionNumber ?? null}
          previousVersionNumber={previousRevision?.versionNumber ?? null}
        />
        <ReviewActivity events={reviewEvents} loading={history.isLoading} />
        <CommentGroups groups={packet.openCommentsBySection} />
        <DecisionSummary decisions={packet.decisions} />
      </div>
    </PanelShell>
  );
}

function workflowActionsFor(status: WorkflowStatus | null): WorkflowStatus[] {
  if (status === "drafting") return ["review", "deferred"];
  if (status === "review") return ["revision", "final-review", "deferred"];
  if (status === "revision") return ["review", "final-review", "deferred"];
  if (status === "final-review") return ["accepted", "revision", "deferred"];
  if (status === "accepted") return ["revision"];
  if (status === "deferred") return ["drafting"];
  return ["review"];
}

function nextReviewRound(current: WorkflowStatus | null, next: WorkflowStatus, currentRound: number | null): number {
  const round = currentRound ?? 0;
  return next === "review" && current === "revision" ? round + 1 : round;
}

function actionDescription(action: RecommendedAction): string {
  if (action === "comment_only") return "Reviewer should leave feedback without broad edits.";
  if (action === "revise") return "Author should address open review comments.";
  if (action === "safe_edit") return "Low-risk edits are allowed with version protection.";
  if (action === "finalize") return "Accepted plan can be promoted when final checks pass.";
  return "Human review is needed before the next workflow step.";
}

function updatePlanningWorkflowFrontmatter(content: string, workflowStatus: WorkflowStatus, reviewRound: number): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  if (!content.startsWith(`---${newline}`)) return content;
  const marker = `${newline}---${newline}`;
  const end = content.indexOf(marker, 3);
  if (end === -1) return content;
  const raw = content.slice(3 + newline.length, end);
  const body = content.slice(end + marker.length);
  const nextFrontmatter = upsertFrontmatterLine(upsertFrontmatterLine(raw, "workflowStatus", workflowStatus), "reviewRound", String(reviewRound));
  return `---${newline}${nextFrontmatter}${newline}---${newline}${body}`;
}

function upsertFrontmatterLine(raw: string, key: string, value: string): string {
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  const nextLine = `${key}: ${value}`;
  if (index >= 0) {
    lines[index] = nextLine;
    return lines.join("\n").trimEnd();
  }
  return [...lines, nextLine].join("\n").trimEnd();
}

function WorkflowActions({
  actions,
  disabled,
  hasUnsavedChanges,
  currentStatus,
  hasAcceptedDecision,
  readyForAcceptedDecision,
  readyToFinalize,
  addingDecision,
  finalizing,
  transitioning,
  transitionError,
  addDecisionError,
  finalizeError,
  onTransition,
  onAddDecision,
  onFinalize,
}: {
  actions: WorkflowStatus[];
  disabled: boolean;
  hasUnsavedChanges: boolean;
  currentStatus: WorkflowStatus | null;
  hasAcceptedDecision: boolean;
  readyForAcceptedDecision: boolean;
  readyToFinalize: boolean;
  addingDecision: boolean;
  finalizing: boolean;
  transitioning: boolean;
  transitionError: unknown;
  addDecisionError: unknown;
  finalizeError: unknown;
  onTransition: (status: WorkflowStatus) => void;
  onAddDecision: () => void;
  onFinalize: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid gap-1.5">
        {actions.map((status) => (
          <Button
            key={status}
            type="button"
            variant={status === "accepted" ? "primary" : "secondary"}
            className="h-8 justify-start px-2.5 text-xs"
            disabled={disabled || status === currentStatus}
            onClick={() => onTransition(status)}
          >
            {actionTextForStatus(status)}
          </Button>
        ))}
        <Button
          type="button"
          variant="secondary"
          className="h-8 justify-start px-2.5 text-xs"
          disabled={disabled || hasAcceptedDecision || !readyForAcceptedDecision}
          onClick={onAddDecision}
        >
          {addingDecision ? "Adding decision..." : "Add accepted final decision"}
        </Button>
        <Button
          type="button"
          variant="primary"
          className="h-8 justify-start px-2.5 text-xs"
          disabled={disabled || !readyToFinalize}
          onClick={onFinalize}
        >
          {finalizing ? "Finalizing..." : "Mark canonical"}
        </Button>
      </div>
      {hasUnsavedChanges ? <p className="text-xs text-amber-700 dark:text-amber-200">Save or discard local edits before changing workflow state.</p> : null}
      {transitioning ? <p className="text-xs text-slate-400">Updating workflow...</p> : null}
      {transitionError ? <p className="text-xs text-red-600">{crudErrorMessage(transitionError)}</p> : null}
      {addDecisionError ? <p className="text-xs text-red-600">{crudErrorMessage(addDecisionError)}</p> : null}
      {finalizeError ? <p className="text-xs text-red-600">{crudErrorMessage(finalizeError)}</p> : null}
    </div>
  );
}

function LatestChanges({
  loading,
  diff,
  latestVersionNumber,
  previousVersionNumber,
}: {
  loading: boolean;
  diff: DocumentDiff | undefined;
  latestVersionNumber: number | null;
  previousVersionNumber: number | null;
}) {
  if (!loading && (!diff || latestVersionNumber === null || previousVersionNumber === null)) {
    return <p className="text-xs italic text-slate-400 dark:text-slate-500">No revision comparison yet.</p>;
  }
  const lines = diff ? diffPreviewLines(diff.unified) : [];
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <FileDiff size={13} aria-hidden="true" />
        Latest changes
      </h3>
      <div className="rounded-md bg-white text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        {loading ? (
          <div className="px-2.5 py-2 text-slate-400">Loading changes...</div>
        ) : diff ? (
          <>
            <div className="border-b border-slate-200 px-2.5 py-2 text-slate-500 dark:border-slate-800 dark:text-slate-400">
              Version {previousVersionNumber} to {latestVersionNumber}: +{diff.added} / -{diff.removed}
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words py-1 font-mono text-[11px] leading-5">
              {lines.map((line, index) => (
                <div key={`${line.kind}-${index}`} className={planningDiffLineClass(line.kind)}>
                  <span className="mr-2 inline-block w-3 select-none text-slate-400">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
                  <span>{line.text || " "}</span>
                </div>
              ))}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ReviewActivity({ events, loading }: { events: ReviewActivityItem[]; loading: boolean }) {
  if (loading) return <p className="text-xs text-slate-400">Loading review activity...</p>;
  if (events.length === 0) {
    return <p className="text-xs italic text-slate-400 dark:text-slate-500">No recent review activity.</p>;
  }
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <Activity size={13} aria-hidden="true" />
        Review activity
      </h3>
      <ul className="space-y-1.5">
        {events.slice(0, 4).map((item) => {
          if (item.type !== "event") return null;
          return (
            <li key={item.id} className="rounded-md bg-white px-2.5 py-2 text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <div className="font-medium text-slate-700 dark:text-slate-200">
                {reviewActivityLabel(item.event.action, item.event.actor)}
                {item.count && item.count > 1 ? <span className="ml-1 text-slate-400">×{item.count}</span> : null}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">{formatDateTime(item.createdAt)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function actionTextForStatus(status: WorkflowStatus): string {
  if (status === "review") return "Send to review";
  if (status === "revision") return "Request revision";
  if (status === "final-review") return "Start final review";
  if (status === "accepted") return "Accept plan";
  if (status === "deferred") return "Defer plan";
  return "Reopen drafting";
}

function flattenRevisions(revisions: DocumentHistory["revisions"]): RevisionEntry[] {
  const out: RevisionEntry[] = [];
  for (const revision of revisions) {
    out.push(revision);
    out.push(...revision.collapsedRevisions);
  }
  return out.sort((a, b) => b.versionNumber - a.versionNumber);
}

function reviewActivityEvents(timeline: DocumentHistory["timeline"]): ReviewActivityItem[] {
  const actions = new Set([
    "comment_added_by_agent",
    "comment_resolved_by_agent",
    "document_plan_reviewed_by_agent",
    "document_section_replaced_by_agent",
    "document_decision_added_by_agent",
    "document_plan_finalized_by_agent",
    "document_updated_by_agent",
  ]);
  const filtered = timeline.filter((item): item is Extract<TimelineItem, { type: "event" }> => item.type === "event" && actions.has(item.event.action));
  const coalesced: ReviewActivityItem[] = [];
  for (const item of filtered) {
    const previous = coalesced[coalesced.length - 1];
    if (previous?.type === "event" && reviewActivityCoalesceKey(previous) === reviewActivityCoalesceKey(item)) {
      previous.count = (previous.count ?? 1) + 1;
      continue;
    }
    coalesced.push({ ...item });
  }
  return coalesced.slice(0, 4);
}

function reviewActivityCoalesceKey(item: Extract<TimelineItem, { type: "event" }>): string {
  const metadata = item.event.metadata && typeof item.event.metadata === "object" && !Array.isArray(item.event.metadata) ? item.event.metadata : {};
  const tokenId = "tokenId" in metadata && typeof metadata.tokenId === "string" ? metadata.tokenId : "";
  return [item.event.action, item.event.actor, item.event.targetId ?? "", tokenId].join(":");
}

type PlanningDiffLine = { kind: "same" | "add" | "remove"; text: string };

function diffPreviewLines(unified: string): PlanningDiffLine[] {
  return unified
    .split("\n")
    .slice(2)
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .slice(0, 12)
    .map((line) => ({
      kind: line.startsWith("+") ? "add" : "remove",
      text: line.slice(1),
    }));
}

function planningDiffLineClass(kind: PlanningDiffLine["kind"]): string {
  if (kind === "add") return "bg-emerald-50 px-2.5 py-0.5 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100";
  if (kind === "remove") return "bg-red-50 px-2.5 py-0.5 text-red-900 line-through dark:bg-red-500/10 dark:text-red-100";
  return "px-2.5 py-0.5 text-slate-700 dark:text-slate-200";
}

function reviewActivityLabel(action: string, actor: string): string {
  const who = actor === "agent" ? "Agent" : actor === "system" ? "System" : actor === "obsidian_plugin" ? "Obsidian" : "User";
  const labels: Record<string, string> = {
    comment_added_by_agent: "Agent added review comment",
    comment_resolved_by_agent: "Agent resolved review comment",
    document_plan_reviewed_by_agent: "Agent submitted planning review",
    document_section_replaced_by_agent: "Agent edited section",
    document_decision_added_by_agent: "Agent added decision",
    document_plan_finalized_by_agent: "Agent finalized plan",
    document_updated_by_agent: "Agent edited document",
  };
  return labels[action] ?? `${who} ${action.replace(/_/g, " ")}`;
}

function PanelShell({ count, children }: { count: number | null; children: ReactNode }) {
  return (
    <section className="my-7 border-y border-slate-200 py-5 dark:border-slate-800">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <GitPullRequestDraft size={13} aria-hidden="true" />
        Planning Review
        {count !== null ? <span className="ml-auto text-slate-400">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-white px-2.5 py-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 truncate font-medium text-slate-700 dark:text-slate-200" title={value}>
        {value}
      </div>
    </div>
  );
}

function ReadinessChecklist({
  openCommentCount,
  openQuestionCount,
  hasBlockingQuestions,
  hasAcceptanceCriteria,
  hasAcceptedDecision,
  readyToFinalize,
}: {
  openCommentCount: number;
  openQuestionCount: number;
  hasBlockingQuestions: boolean;
  hasAcceptanceCriteria: boolean;
  hasAcceptedDecision: boolean;
  readyToFinalize: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <ChecklistItem ok={openCommentCount === 0} label={openCommentCount === 0 ? "No open comments" : `${openCommentCount} open comment${openCommentCount === 1 ? "" : "s"}`} />
      <ChecklistItem ok={openQuestionCount === 0 && !hasBlockingQuestions} label={openQuestionCount === 0 ? "No open questions" : `${openQuestionCount} open question${openQuestionCount === 1 ? "" : "s"}`} />
      <ChecklistItem ok={hasAcceptanceCriteria} label={hasAcceptanceCriteria ? "Acceptance criteria present" : "Missing acceptance criteria"} />
      <ChecklistItem ok={hasAcceptedDecision} label={hasAcceptedDecision ? "Accepted decision present" : "Missing accepted decision"} />
      <div className={`mt-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-xs ${readyToFinalize ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-100" : "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300"}`}>
        <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{readyToFinalize ? "Ready for canonical promotion." : "Not ready to finalize yet."}</span>
      </div>
    </div>
  );
}

function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 text-xs ${ok ? "text-emerald-700 dark:text-emerald-200" : "text-amber-800 dark:text-amber-200"}`}>
      <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function CommentGroups({ groups }: { groups: Packet["openCommentsBySection"] }) {
  if (groups.length === 0) {
    return <p className="text-xs italic text-slate-400 dark:text-slate-500">No open review comments.</p>;
  }
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <MessageSquare size={13} aria-hidden="true" />
        Review comments
      </h3>
      <ul className="space-y-2">
        {groups.map((group) => (
          <li key={group.sectionAnchor ?? "document"} className="rounded-md bg-white px-2.5 py-2 text-xs ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <div className="mb-1 flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-950">
                {group.sectionAnchor ? `#${group.sectionAnchor}` : "document"}
              </code>
              <span>{group.count}</span>
            </div>
            <ul className="space-y-1.5">
              {group.comments.slice(0, 3).map((comment, index) => (
                <li key={comment.id ?? `${group.sectionAnchor ?? "document"}-${index}`} className="max-h-16 overflow-hidden leading-5 text-slate-700 dark:text-slate-200">
                  {comment.body}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionSummary({ decisions }: { decisions: Packet["decisions"] }) {
  if (decisions.length === 0) {
    return (
      <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
        <CircleDashed size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>No structured decisions yet.</span>
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Decisions</h3>
      <ul className="space-y-1.5">
        {decisions.slice(0, 4).map((decision) => (
          <li key={decision.id} className="flex min-w-0 items-center gap-2 text-xs">
            <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {decision.status}
            </span>
            <code className="min-w-0 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">{decision.id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
