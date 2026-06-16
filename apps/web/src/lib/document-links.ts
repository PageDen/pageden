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

export function normalizeReadableDocumentPath(path: string): string {
  const decoded = path
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
  return decoded.toLowerCase().endsWith(".md") ? decoded : `${decoded}.md`;
}
