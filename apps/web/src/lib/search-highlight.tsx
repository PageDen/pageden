import type { ReactNode } from "react";

// Search snippets arrive with matched spans wrapped in these private-use markers (kept in sync
// with the server). We split on them and render only the matched spans as <mark>; every piece is
// rendered as React children, so it is escaped — document content can never inject markup.
const HL_START = "\uE000";
const HL_STOP = "\uE001";

export function highlightSnippet(snippet: string): ReactNode[] {
  const segments: Array<{ text: string; hit: boolean }> = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(HL_START);
    if (start === -1) {
      segments.push({ text: rest, hit: false });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), hit: false });
    rest = rest.slice(start + HL_START.length);
    const stop = rest.indexOf(HL_STOP);
    const matched = stop === -1 ? rest : rest.slice(0, stop);
    segments.push({ text: matched, hit: true });
    rest = stop === -1 ? "" : rest.slice(stop + HL_STOP.length);
  }
  return segments.map((seg, i) =>
    seg.hit ? (
      <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 not-italic text-slate-800">
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}
