import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Activity, AlertTriangle, ArrowRight, ClipboardList, FileText, FolderTree, Hand, Sparkles } from "lucide-react";
import type { z } from "zod";
import type { documentStatusSchema } from "@pageden/api-types";
import { ApiError } from "../../lib/api";
import { documentReadablePath } from "../../lib/document-links";
import { workspaceDashboardQuery } from "../../lib/queries";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { ActivityRow } from "./activity-row";

type Status = z.infer<typeof documentStatusSchema>;

const statusLabel: Record<Status, string> = {
  canonical: "Canonical",
  draft: "Draft",
  superseded: "Superseded",
  archived: "Archived",
};

const statusTone: Record<Status, string> = {
  canonical: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200",
  draft: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200",
  superseded: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  archived: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export function WorkspaceDashboard() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const dashboard = useQuery({ ...workspaceDashboardQuery(workspaceId), enabled: workspaceId !== "" });
  usePageTitle(pageTitle("Dashboard"));

  if (dashboard.isLoading) return <div className="p-8 text-slate-400">Loading dashboard…</div>;
  if (dashboard.isError) {
    const notFound = dashboard.error instanceof ApiError && dashboard.error.status === 404;
    return (
      <div className="p-8 text-slate-500">
        {notFound ? "Workspace not found." : "Could not load the dashboard."}
      </div>
    );
  }
  const d = dashboard.data!;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-8 text-slate-950 dark:text-slate-100">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">Implementation dashboard</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Source-of-truth health</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Workspace-wide view of canonical vs superseded docs, recent activity, and where the work lives.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(d.statusCounts) as Status[]).map((status) => (
          <StatusCard key={status} status={status} count={d.statusCounts[status]} />
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,0.9fr)]">
        <section className="space-y-4">
          <Card icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />} title="Superseded — point readers at the replacement">
            {d.supersededDocs.length === 0 ? (
              <p className="text-sm italic text-slate-400">No superseded documents.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.supersededDocs.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-1.5">
                    <Link
                      to={documentReadablePath(workspaceId, doc.path)}
                      className="font-medium text-slate-700 hover:text-orange-700 dark:text-slate-200 dark:hover:text-orange-300"
                    >
                      {doc.title}
                    </Link>
                    <span className="text-slate-400">{doc.path}</span>
                    {doc.supersededBy ? (
                      <>
                        <ArrowRight size={13} className="text-amber-600" aria-hidden="true" />
                        <Link
                          to={documentReadablePath(workspaceId, doc.supersededBy.path)}
                          className="font-semibold text-amber-800 hover:underline dark:text-amber-200"
                        >
                          {doc.supersededBy.title}
                        </Link>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<FolderTree className="h-5 w-5" aria-hidden="true" />} title="Top folders by document count">
            {d.topFolders.length === 0 ? (
              <p className="text-sm italic text-slate-400">No folders yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.topFolders.map((folder) => (
                  <li key={folder.id} className="flex justify-between gap-2">
                    <span className="truncate text-slate-700 dark:text-slate-300">{folder.path}</span>
                    <span className="shrink-0 text-slate-400">{folder.documentCount}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section className="space-y-4">
          <Card icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />} title="Recently updated">
            {d.recentChanges.length === 0 ? (
              <p className="text-sm italic text-slate-400">No changes yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {d.recentChanges.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      to={documentReadablePath(workspaceId, doc.path)}
                      className="truncate font-medium text-slate-700 hover:text-orange-700 dark:text-slate-200 dark:hover:text-orange-300"
                    >
                      {doc.title}
                    </Link>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusTone[doc.status]}`}>
                      {statusLabel[doc.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<Hand className="h-5 w-5" aria-hidden="true" />} title={`Active claims (${d.activeClaims.length})`}>
            {d.activeClaims.length === 0 ? (
              <p className="text-sm italic text-slate-400">No documents are currently claimed.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {d.activeClaims.map((claim) => (
                  <li key={claim.id} className="flex flex-wrap items-center gap-2">
                    <Link
                      to={documentReadablePath(workspaceId, claim.document.path)}
                      className="truncate font-medium text-slate-700 hover:text-orange-700 dark:text-slate-200 dark:hover:text-orange-300"
                    >
                      {claim.document.title}
                    </Link>
                    <span className="text-xs text-slate-500 dark:text-slate-400">by {claim.actorLabel ?? (claim.tokenId ? "an agent" : "a user")}</span>
                    <span className="text-xs text-slate-400">expires {new Date(claim.expiresAt).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<Activity className="h-5 w-5" aria-hidden="true" />} title="Recent activity">
            {d.recentActivity.length === 0 ? (
              <p className="text-sm italic text-slate-400">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
                {d.recentActivity.map((event) => (
                  <ActivityRow key={event.id} event={event} workspaceId={workspaceId} compact />
                ))}
              </ul>
            )}
            <div className="mt-3 text-right">
              <Link
                to="/w/$workspaceId/activity"
                params={{ workspaceId }}
                className="text-xs font-semibold text-orange-700 hover:underline dark:text-orange-300"
              >
                View all activity →
              </Link>
            </div>
          </Card>
        </section>
      </div>
    </main>
  );
}

function StatusCard({ status, count }: { status: Status; count: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{statusLabel[status]}</p>
      <p className="mt-2 text-3xl font-semibold text-slate-950 dark:text-slate-50">{count}</p>
      <span className={`mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusTone[status]}`}>
        {status === "canonical" ? <Sparkles size={10} aria-hidden="true" /> : <FileText size={10} aria-hidden="true" />}
        docs
      </span>
    </div>
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
