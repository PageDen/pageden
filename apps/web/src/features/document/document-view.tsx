import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { documentQuery, meQuery } from "../../lib/queries";
import { ApiError } from "../../lib/api";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { DocumentEditor } from "./document-editor";

export function DocumentView() {
  const params = useParams({ strict: false });
  const documentId = params.documentId ?? "";
  const workspaceId = params.workspaceId ?? "";
  const me = useQuery(meQuery);
  const doc = useQuery({ ...documentQuery(documentId), enabled: documentId !== "" });
  const workspaceName = me.data?.workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  const visibleDocument = doc.data?.workspaceId === workspaceId ? doc.data : undefined;
  usePageTitle(visibleDocument ? pageTitle(visibleDocument.title, workspaceName) : "Pageden");

  if (doc.isLoading) {
    return <div className="p-8 text-slate-400">Loading…</div>;
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
