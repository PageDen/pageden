import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { documentQuery, meQuery, treeQuery } from "../../lib/queries";
import { ApiError } from "../../lib/api";
import { normalizeReadableDocumentPath } from "../../lib/document-links";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { DocumentEditor } from "./document-editor";

export function DocumentView() {
  const params = useParams({ strict: false }) as { workspaceId?: string; documentId?: string; _splat?: string };
  const documentId = params.documentId ?? "";
  const documentPath = params._splat ? normalizeReadableDocumentPath(params._splat) : "";
  const workspaceId = params.workspaceId ?? "";
  const me = useQuery(meQuery);
  const tree = useQuery({ ...treeQuery(workspaceId), enabled: workspaceId !== "" && documentId === "" && documentPath !== "" });
  const pathDocument = tree.data?.documents.find((candidate) => candidate.path === documentPath);
  const resolvedDocumentId = documentId || pathDocument?.id || "";
  const doc = useQuery({ ...documentQuery(resolvedDocumentId), enabled: resolvedDocumentId !== "" });
  const workspaceName = me.data?.workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  const visibleDocument = doc.data?.workspaceId === workspaceId ? doc.data : undefined;
  usePageTitle(visibleDocument ? pageTitle(visibleDocument.title, workspaceName) : "Pageden");

  if (tree.isLoading || doc.isLoading) {
    return <div className="p-8 text-slate-400">Loading…</div>;
  }
  if (documentId === "" && documentPath !== "" && !pathDocument) {
    return (
      <div className="p-8 text-slate-500">This document was not found, or you don't have access to it.</div>
    );
  }
  if (doc.isError) {
    const notFound = doc.error instanceof ApiError && doc.error.status === 404;
    return (
      <div className="p-8 text-slate-500">
        {notFound ? "This document was not found, or you don't have access to it." : "Could not load this document."}
      </div>
    );
  }
  const d = doc.data!;
  // Existence-hiding: a document id from another workspace must not render in this shell.
  if (d.workspaceId !== workspaceId) {
    return (
      <div className="p-8 text-slate-500">This document was not found, or you don't have access to it.</div>
    );
  }
  return <DocumentEditor key={d.id} doc={d} workspaceId={workspaceId} />;
}
