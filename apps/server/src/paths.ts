// Slug + path helpers. Slugs become filesystem names, so keep them strict and lowercase.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Folder path is the parent path joined with the slug (root folders have no parent path). */
export function buildFolderPath(parentPath: string | null, slug: string): string {
  return parentPath ? `${parentPath}/${slug}` : slug;
}

/** Document path is the containing folder path joined with `<slug>.md`. */
export function buildDocumentPath(folderPath: string, slug: string): string {
  return folderPath ? `${folderPath}/${slug}.md` : `${slug}.md`;
}

/**
 * Re-root a descendant path when an ancestor folder moves/renames.
 * Replaces the `oldPrefix` segment of `path` with `newPrefix`.
 */
export function rerootPath(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  return path;
}
