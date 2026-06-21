export interface MarkdownHeading {
  heading: string;
  anchor: string;
  level: number;
  startLine: number;
}

export function extractMarkdownHeadings(body: string, anchorFor: (heading: string) => string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;

  body.split("\n").forEach((line, startLine) => {
    const fence = detectFenceMarker(line);
    if (inFence) {
      if (fence && fenceMarker && fence[0] === fenceMarker[0] && fence.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
      }
      return;
    }
    if (fence) {
      inFence = true;
      fenceMarker = fence;
      return;
    }

    const parsed = parseMarkdownHeading(line);
    if (!parsed) return;
    headings.push({ ...parsed, anchor: anchorFor(parsed.heading), startLine });
  });

  return headings;
}

export function parseMarkdownHeading(line: string): { heading: string; level: number } | null {
  let i = 0;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35 /* # */ && level < 6) {
    i += 1;
    level += 1;
  }
  if (level === 0) return null;
  if (i >= line.length) return null;
  const next = line.charCodeAt(i);
  if (next !== 32 && next !== 9) return null;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i += 1;
  }
  const heading = stripTrailingAtxClosing(line.slice(i)).trim();
  return heading ? { heading, level } : null;
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
