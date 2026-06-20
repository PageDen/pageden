export function stripDocumentExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function documentReadablePath(workspaceId: string, documentPath: string): string {
  const readablePath = stripDocumentExtension(documentPath)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/w/${encodeURIComponent(workspaceId)}/p/${readablePath}`;
}

/**
 * The workspace-relative path of a document, exactly as agents reference it
 * through the MCP tools (e.g. pageden_read_document path="docs/foo.md"). We
 * keep the stored ".md" path verbatim and only strip a leading slash so the
 * string can be pasted straight into a prompt.
 */
export function workspaceRelativePath(documentPath: string): string {
  return documentPath.replace(/^\/+/, "");
}

/**
 * Stable, id-based deep link to a document. Survives renames/moves (unlike the
 * readable path) so it's the right thing to hand a human in chat. `origin`
 * defaults to the current browser origin.
 */
export function documentDeepLink(workspaceId: string, documentId: string, origin?: string): string {
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/w/${encodeURIComponent(workspaceId)}/d/${encodeURIComponent(documentId)}`;
}

/**
 * A copy-paste review note bundling both references plus an agent hint, so a
 * single paste tells a human where to click and tells an agent how to read it.
 */
export function documentReviewNote(args: {
  workspaceId: string;
  documentId: string;
  path: string;
  origin?: string;
}): string {
  const relPath = workspaceRelativePath(args.path);
  const link = documentDeepLink(args.workspaceId, args.documentId, args.origin);
  return [
    `Please review: ${relPath}`,
    link,
    "",
    `(Agent: read with pageden_read_document path="${relPath}")`,
  ].join("\n");
}

export function normalizeReadableDocumentPath(path: string): string {
  const decoded = path
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
  return decoded.toLowerCase().endsWith(".md") ? decoded : `${decoded}.md`;
}
