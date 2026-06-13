// Build a downloadable Markdown file for a document: canonical body with reconstructed YAML
// frontmatter. Server-managed metadata (title, path, version, updatedAt, checksum) is always
// written and wins over any frontmatter already stored in the document; remaining stored
// frontmatter keys are preserved beneath them. The original frontmatter fence is stripped from
// the body so keys are never duplicated.
import { documentContext } from "../ai-readiness.js";

export interface DownloadMeta {
  title: string;
  path: string;
  version: string | null;
  updatedAt: string; // ISO 8601 UTC
  checksum: string | null;
}

// Keys the server always controls in the downloaded frontmatter, in emit order.
const RESERVED_KEYS = ["title", "path", "version", "updatedAt", "checksum"] as const;
const RESERVED = new Set<string>(RESERVED_KEYS);

export function buildDownloadMarkdown(meta: DownloadMeta, content: string): string {
  const { body, frontmatter } = documentContext(content);

  const entries: Array<[string, string | string[]]> = [
    ["title", meta.title],
    ["path", meta.path],
  ];
  if (meta.version) entries.push(["version", meta.version]);
  entries.push(["updatedAt", meta.updatedAt]);
  if (meta.checksum) entries.push(["checksum", meta.checksum]);

  // Preserve any non-reserved frontmatter the author had stored.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (RESERVED.has(key)) continue;
    entries.push([key, value]);
  }

  const yaml = entries.map(([key, value]) => `${key}: ${emitYamlValue(value)}`).join("\n");
  // Canonical output: frontmatter fence, blank line, body, exactly one trailing LF.
  return `---\n${yaml}\n---\n\n${body}`.replace(/\n*$/, "\n");
}

function emitYamlValue(value: string | string[]): string {
  if (Array.isArray(value)) return `[${value.map(quoteScalar).join(", ")}]`;
  return quoteScalar(value);
}

// Always double-quote scalars (escaping backslash and quote) so any value — including ones
// containing ':', '#', or leading spaces — is valid YAML.
function quoteScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Derive the download filename from the document path basename; always ends in `.md`.
export function downloadFilename(path: string): string {
  const base = (path.split("/").pop() || "document").trim() || "document";
  const name = /\.md$/i.test(base) ? base : `${base}.md`;
  // Strip characters that are unsafe in a Content-Disposition filename token.
  return name.replace(/["\\/\r\n]/g, "_");
}

// RFC 6266 Content-Disposition with an ASCII filename and a UTF-8 filename* fallback.
export function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
