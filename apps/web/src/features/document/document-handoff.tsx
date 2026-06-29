import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  CornerDownLeft,
  CornerDownRight,
  ExternalLink,
  FileText,
  GitPullRequest,
  Link2,
  ListChecks,
  Network,
  ScrollText,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { z } from "zod";
import type {
  handoffPacketSchema,
  implementationReadinessSchema,
  implementationReadinessStatusSchema,
  relatedDocsSchema,
} from "@pageden/api-types";
import { ApiError } from "../../lib/api";
import { documentHandoffQuery, documentRelatedDocsQuery } from "../../lib/queries";
import { documentReadablePath } from "../../lib/document-links";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { DocumentCommentsPanel } from "./document-comments-panel";

type Handoff = z.infer<typeof handoffPacketSchema>;
type Readiness = z.infer<typeof implementationReadinessSchema>;
type ReadinessStatus = z.infer<typeof implementationReadinessStatusSchema>;

const readinessLabel: Record<ReadinessStatus, string> = {
  ready_to_implement: "Ready to implement",
  needs_contract_update: "Needs contract update",
  has_blocking_questions: "Has blocking questions",
  conflicting_guidance: "Conflicting guidance",
  draft_only: "Draft only",
  superseded: "Superseded",
  // F15: docType=reference/decision-log/operational/etc opts out of the
  // implementation-readiness scoring entirely.
  not_applicable: "Not an implementation doc",
};

const readinessTone: Record<ReadinessStatus, string> = {
  ready_to_implement: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/30",
  needs_contract_update: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30",
  has_blocking_questions: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30",
  conflicting_guidance: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30",
  draft_only: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-400/30",
  superseded: "bg-slate-100 text-slate-600 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  not_applicable: "bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:ring-slate-700",
};

export function DocumentHandoff() {
  const params = useParams({ strict: false });
  const documentId = params.documentId ?? "";
  const workspaceId = params.workspaceId ?? "";
  const handoff = useQuery({ ...documentHandoffQuery(documentId), enabled: documentId !== "" });
  usePageTitle(handoff.data ? pageTitle(`Handoff — ${handoff.data.title}`) : "Handoff");

  if (handoff.isLoading) return <div className="p-8 text-slate-400">Loading handoff…</div>;
  if (handoff.isError) {
    const notFound = handoff.error instanceof ApiError && handoff.error.status === 404;
    return (
      <div className="p-8 text-slate-500">
        {notFound ? "This document was not found, or you don't have access to it." : "Could not build a handoff for this document."}
      </div>
    );
  }
  const h = handoff.data!;
  if (h.workspaceId !== workspaceId) {
    return <div className="p-8 text-slate-500">This document was not found, or you don't have access to it.</div>;
  }
  return <HandoffView h={h} workspaceId={workspaceId} />;
}

function HandoffView({ h, workspaceId }: { h: Handoff; workspaceId: string }) {
  const { packet } = h;
  const relatedDocs = useQuery({ ...documentRelatedDocsQuery(h.documentId), enabled: h.documentId !== "" });
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8 text-slate-950 dark:text-slate-100">
      <div className="flex items-center justify-between gap-4">
        <Link
          to={documentReadablePath(workspaceId, h.path)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to document
        </Link>
        <ReadinessBadge readiness={packet.implementationReadiness} />
      </div>

      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">Handoff packet</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{h.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{h.path}</p>
      </header>

      {packet.supersededBy ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100">
          <AlertTriangle size={16} aria-hidden="true" />
          <span className="font-medium">Superseded.</span>
          <span>Use</span>
          <Link
            to={documentReadablePath(workspaceId, packet.supersededBy.path)}
            className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
          >
            {packet.supersededBy.title}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
          <span className="text-amber-800/80 dark:text-amber-200/80">({packet.supersededBy.path})</span>
        </div>
      ) : null}

      <Card icon={<ScrollText className="h-5 w-5" aria-hidden="true" />} title="Summary">
        <p className="text-sm leading-6 text-slate-700 dark:text-slate-300">
          {packet.summary || "No summary section was detected."}
        </p>
      </Card>

      <ReadinessReasons readiness={packet.implementationReadiness} />

      <div className="grid gap-4 md:grid-cols-2">
        <ListCard icon={<ArrowRight className="h-4 w-4" aria-hidden="true" />} title={packet.currentPhase ? `Next steps — ${packet.currentPhase}` : "Next steps"} items={packet.nextSteps} emptyHint="Add a 'Next steps' or 'First PR' section." />
        <ListCard icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />} title="Acceptance criteria" items={packet.acceptanceCriteria} emptyHint="Add a 'Definition of Done' or 'Acceptance criteria' section." />
        <ListCard icon={<ListChecks className="h-4 w-4" aria-hidden="true" />} title="Tests" items={packet.tests} emptyHint="Add a 'Tests' or 'Test plan' section." />
        <ListCard icon={<XCircle className="h-4 w-4" aria-hidden="true" />} title="Non-goals" items={packet.nonGoals} emptyHint="State what is intentionally out of scope." />
        <ListCard icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />} title="Open questions" items={packet.openQuestions} emptyHint="No open questions detected." />
        <DecisionsCard decisions={packet.decisions} />
      </div>

      {packet.prLinks.length ? (
        <Card icon={<GitPullRequest className="h-5 w-5" aria-hidden="true" />} title="Linked PRs / issues">
          <ul className="grid gap-1.5 text-sm">
            {packet.prLinks.map((link) => (
              <li key={link} className="flex items-center gap-1.5">
                <ExternalLink size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-medium text-orange-700 hover:underline dark:text-orange-300"
                >
                  {link}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <RelatedDocsCard workspaceId={workspaceId} data={relatedDocs.data} isLoading={relatedDocs.isLoading} isError={relatedDocs.isError} />

      {packet.relatedFiles.length ? (
        <Card icon={<Network className="h-5 w-5" aria-hidden="true" />} title="Likely source files">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {packet.relatedFiles.map((file) => (
              <li key={file} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <FileText size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                <code className="truncate font-mono text-xs">{file}</code>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <DocumentCommentsPanel documentId={h.documentId} />
    </main>
  );
}

function ReadinessBadge({ readiness }: { readiness: Readiness }) {
  const Icon =
    readiness.status === "ready_to_implement" ? CheckCircle2 : readiness.status === "superseded" ? AlertTriangle : CircleDashed;
  return (
    <span className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ring-1 ${readinessTone[readiness.status]}`}>
      <Icon size={14} aria-hidden="true" />
      {readinessLabel[readiness.status]}
      <span className="ml-1 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-700 dark:bg-slate-950/40 dark:text-slate-200">
        {readiness.score}
      </span>
    </span>
  );
}

function ReadinessReasons({ readiness }: { readiness: Readiness }) {
  if (!readiness.reasons.length) return null;
  return (
    <Card icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />} title="Why this status">
      <ul className="space-y-1.5">
        {readiness.reasons.map((reason) => (
          <li key={reason.code} className="flex items-start gap-2 text-sm">
            <span
              className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                reason.severity === "blocking"
                  ? "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200"
                  : reason.severity === "warning"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }`}
              aria-label={reason.severity}
            >
              {reason.severity === "blocking" ? "!" : reason.severity === "warning" ? "•" : "i"}
            </span>
            <span className="text-slate-700 dark:text-slate-300">{reason.message}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DecisionsCard({ decisions }: { decisions: Handoff["packet"]["decisions"] }) {
  return (
    <Card icon={<Sparkles className="h-4 w-4" aria-hidden="true" />} title="Decisions">
      {decisions.length === 0 ? (
        <p className="text-sm italic text-slate-400 dark:text-slate-500">
          No structured <code>:::decision</code> blocks were detected.
        </p>
      ) : (
        <ul className="space-y-3 text-sm">
          {decisions.map((decision) => (
            <li key={decision.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {decision.id}
                </code>
                <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800 dark:bg-orange-500/15 dark:text-orange-200">
                  {decision.status}
                </span>
                {decision.owner ? <span>· {decision.owner}</span> : null}
                {decision.date ? <span>· {decision.date}</span> : null}
              </div>
              {decision.decision ? (
                <p className="mt-2 leading-6 text-slate-800 dark:text-slate-200">{decision.decision}</p>
              ) : null}
              {decision.reason ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{decision.reason}</p>
              ) : null}
              {decision.replaces ? (
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">replaces: {decision.replaces}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type RelatedDocs = z.infer<typeof relatedDocsSchema>;
type RelatedDocRef = RelatedDocs["references"][number];

function RelatedDocsCard({
  workspaceId,
  data,
  isLoading,
  isError,
}: {
  workspaceId: string;
  data: RelatedDocs | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Card icon={<Network className="h-5 w-5" aria-hidden="true" />} title="Related documents">
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }
  if (isError || !data) return null;
  const sections: Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    items: RelatedDocRef[];
  }> = [
    { key: "supersedes", label: "Supersedes", icon: <CornerDownRight size={13} aria-hidden="true" />, items: data.supersedes },
    { key: "supersededBy", label: "Superseded by", icon: <CornerDownLeft size={13} aria-hidden="true" />, items: data.supersededBy ? [data.supersededBy] : [] },
    { key: "references", label: "References (outbound)", icon: <ArrowRight size={13} aria-hidden="true" />, items: data.references },
    { key: "referencedBy", label: "Referenced by (backlinks)", icon: <Link2 size={13} aria-hidden="true" />, items: data.referencedBy },
  ];
  const visible = sections.filter((section) => section.items.length > 0);
  if (visible.length === 0) {
    return (
      <Card icon={<Network className="h-5 w-5" aria-hidden="true" />} title="Related documents">
        <p className="text-sm italic text-slate-400 dark:text-slate-500">
          No supersedes / references / backlinks detected. Use{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            [[doc-path]]
          </code>{" "}
          wikilinks to start building the graph.
        </p>
      </Card>
    );
  }
  return (
    <Card icon={<Network className="h-5 w-5" aria-hidden="true" />} title="Related documents">
      <div className="grid gap-4 md:grid-cols-2">
        {visible.map((section) => (
          <div key={section.key}>
            <header className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <span className="text-orange-600 dark:text-orange-300">{section.icon}</span>
              {section.label}
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {section.items.length}
              </span>
            </header>
            <ul className="space-y-1">
              {section.items.map((doc) => (
                <li key={doc.id}>
                  <Link
                    to={documentReadablePath(workspaceId, doc.path)}
                    className="block truncate rounded-md border border-transparent px-2 py-1 text-sm text-slate-700 hover:border-slate-200 hover:bg-slate-50 dark:text-slate-200 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
                  >
                    <span className="truncate">{doc.title}</span>
                    {doc.status !== "canonical" ? (
                      <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
                        {doc.status}
                      </span>
                    ) : null}
                    <span className="block truncate text-xs text-slate-400 dark:text-slate-500">{doc.path}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center gap-2 text-slate-700 dark:text-slate-200">
        <span className="text-orange-600 dark:text-orange-300">{icon}</span>
        <h2 className="text-base font-semibold">{title}</h2>
      </header>
      {children}
    </section>
  );
}

function ListCard({
  icon,
  title,
  items,
  emptyHint,
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  emptyHint: string;
}) {
  return (
    <Card icon={icon} title={title}>
      {items.length ? (
        <ul className="space-y-1.5 text-sm leading-6 text-slate-700 dark:text-slate-300">
          {items.map((item, idx) => (
            <li key={`${item}-${idx}`} className="flex gap-2">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm italic text-slate-400 dark:text-slate-500">{emptyHint}</p>
      )}
    </Card>
  );
}
