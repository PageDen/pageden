import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, GitPullRequestDraft, MessageSquare, RadioTower, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { z } from "zod";
import type { handoffPacketSchema } from "@pageden/api-types";
import { documentHandoffQuery } from "../../lib/queries";

type Handoff = z.infer<typeof handoffPacketSchema>;
type Packet = Handoff["packet"];
type RecommendedAction = NonNullable<Packet["recommendedAction"]>;

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

export function PlanningReviewPanel({ documentId, enabled }: { documentId: string; enabled: boolean }) {
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

  return <PlanningReviewContent packet={handoff.data.packet} />;
}

function PlanningReviewContent({ packet }: { packet: Packet }) {
  const workflow = packet.workflow;
  if (!workflow) return null;

  const openCommentCount = packet.openCommentsBySection.reduce((sum, group) => sum + group.count, 0);
  const acceptedDecision = packet.decisions.find((decision) => decision.status.toLowerCase() === "accepted");
  const hasAcceptanceCriteria = packet.acceptanceCriteria.length > 0;
  const hasBlockingQuestions = packet.openQuestions.some((question) => /\b(blocking|blocked|must|before final)\b/i.test(question));
  const readyToFinalize =
    packet.recommendedAction === "finalize" &&
    openCommentCount === 0 &&
    packet.openQuestions.length === 0 &&
    hasAcceptanceCriteria &&
    Boolean(acceptedDecision);

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

        <CommentGroups groups={packet.openCommentsBySection} />
        <DecisionSummary decisions={packet.decisions} />
      </div>
    </PanelShell>
  );
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
