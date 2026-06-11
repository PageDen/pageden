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

function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    // Match markdown headings: # H1, ## H2, ### H3, etc.
    const match = line.match(/^(#{1,6})\s+(.+?)(?:\s*#*)?$/);
    if (match) {
      const marks = match[1];
      const rawText = match[2];
      if (!marks || !rawText) continue;
      const level = marks.length;
      const text = rawText.trim();
      // Generate ID from text (kebab-case)
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      headings.push({ level, text, id });
    }
  }

  return headings;
}
