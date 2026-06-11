import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { documentQuery, meQuery, revisionsQuery } from "../../lib/queries";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";

const sourceLabel: Record<string, string> = {
  web_app: "Web",
  obsidian_plugin: "Obsidian",
  import: "Import",
  system: "System",
};

export function RevisionHistory() {
  const params = useParams({ strict: false });
  const documentId = params.documentId ?? "";
  const workspaceId = params.workspaceId ?? "";
  const revs = useQuery({ ...revisionsQuery(documentId), enabled: documentId !== "" });
  const doc = useQuery({ ...documentQuery(documentId), enabled: documentId !== "" });
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = doc.data?.permission === "manager";
  const workspaceName = me.data?.workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  usePageTitle(pageTitle("History", doc.data?.title, workspaceName));
  const restore = useMutation({
    mutationFn: (revisionId: string) => api.restoreRevision(documentId, revisionId),
    onSuccess: () => {
      // Drop cached copies so the document route loads the freshly-restored content.
      queryClient.removeQueries({ queryKey: documentQuery(documentId).queryKey });
      queryClient.removeQueries({ queryKey: revisionsQuery(documentId).queryKey });
      void navigate({ to: "/w/$workspaceId/d/$documentId", params: { workspaceId, documentId } });
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Revision history</h1>
        <Link
          to="/w/$workspaceId/d/$documentId"
          params={{ workspaceId, documentId }}
          className="text-sm text-slate-500 underline hover:text-slate-800"
        >
          Back to document
        </Link>
      </div>
      {revs.isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : revs.isError ? (
        <p className="text-slate-500">
          {revs.error instanceof ApiError && revs.error.status === 404
            ? "This document was not found, or you don't have access to it."
            : "Could not load history."}
        </p>
      ) : revs.data!.revisions.length === 0 ? (
        <p className="text-slate-400">No revisions yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {revs.data!.revisions.map((r, index) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className="font-medium">v{r.versionNumber}</span>
              <span className="text-slate-500">{sourceLabel[r.changeSource] ?? r.changeSource}</span>
              <span className="flex-1 text-right text-slate-400">{formatDateTime(r.createdAt)}</span>
              {canManage && index > 0 ? (
                <Button variant="ghost" onClick={() => restore.mutate(r.id)} disabled={restore.isPending}>
                  Restore
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
