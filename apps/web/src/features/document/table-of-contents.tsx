import { useMemo } from "react";

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export function TableOfContents({ content, embedded = false }: { content: string; embedded?: boolean }) {
  const headings = useMemo(() => extractHeadings(content), [content]);

  if (headings.length === 0) {
    return null;
  }

  const body = (
    <div>
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">On this page</div>
      <nav className="space-y-1">
        {headings.map((heading) => (
          <a
            key={heading.id}
            href={`#${heading.id}`}
            className="block truncate rounded px-2 py-1 text-xs text-slate-600 transition hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100"
            style={{ marginLeft: `${(heading.level - 1) * 0.75}rem` }}
            title={heading.text}
          >
            {heading.text}
          </a>
        ))}
      </nav>
    </div>
  );

  if (embedded) return body;

  return (
    <aside className="w-48 flex-shrink-0 overflow-auto border-l border-slate-200 bg-slate-50 px-3 py-6 dark:border-slate-800 dark:bg-slate-950">
      {body}
    </aside>
  );
}

export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceMarker: string | null = null;
  const idForHeading = createHeadingIdGenerator();

  for (const line of lines) {
    const fence = detectFenceMarker(line);
    if (inFence) {
      if (fence && fenceMarker && fence[0] === fenceMarker[0] && fence.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (fence) {
      inFence = true;
      fenceMarker = fence;
      continue;
    }

    const heading = parseMarkdownHeading(line);
    if (!heading) continue;
    headings.push({ level: heading.level, text: heading.text, id: idForHeading(heading.text) });
  }

  return headings;
}

function parseMarkdownHeading(line: string): { level: number; text: string } | null {
  let i = 0;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35 /* # */ && level < 6) {
    i += 1;
    level += 1;
  }
  if (level === 0 || i >= line.length) return null;
  const next = line.charCodeAt(i);
  if (next !== 32 && next !== 9) return null;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i += 1;
  }
  const text = stripTrailingAtxClosing(line.slice(i)).trim();
  return text ? { level, text } : null;
}

function detectFenceMarker(line: string): string | null {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i += 1;
  if (i >= line.length) return null;
  const ch = line.charCodeAt(i);
  if (ch !== 96 /* ` */ && ch !== 126 /* ~ */) return null;
  let end = i;
  while (end < line.length && line.charCodeAt(end) === ch) end += 1;
  if (end - i < 3) return null;
  return line.slice(i, end);
}

function stripTrailingAtxClosing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end -= 1;
  }
  let hashStart = end;
  while (hashStart > 0 && s.charCodeAt(hashStart - 1) === 35) hashStart -= 1;
  if (hashStart === end || hashStart === 0) return s.slice(0, end);
  const before = s.charCodeAt(hashStart - 1);
  if (before !== 32 && before !== 9) return s.slice(0, end);
  let stop = hashStart - 1;
  while (stop > 0) {
    const c = s.charCodeAt(stop - 1);
    if (c !== 32 && c !== 9) break;
    stop -= 1;
  }
  return s.slice(0, stop);
}

export function headingId(text: string): string {
  const id = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return id || "section";
}

export function createHeadingIdGenerator(): (text: string) => string {
  const counts = new Map<string, number>();
  return (text: string) => {
    const base = headingId(text);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    return next === 1 ? base : `${base}-${next}`;
  };
}
