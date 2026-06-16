// Section-level edit primitives — counterpart to extractSections in handoff.ts.
//
// extractSections returns a flat list of sections with their text content;
// this module exposes the line-range view + a splice function so we can do
// pageden_replace_section without round-tripping the full body. Wrapped in
// its own file so a future markdown-AST refactor (Feature 17) can swap the
// implementation without leaking through to the MCP/REST layers.

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export interface SectionRange {
  heading: string;
  anchor: string;
  level: number;
  /** Line index of the heading itself (0-based). */
  headingLine: number;
  /** First line of the section's body. */
  contentStart: number;
  /** Exclusive end — either the next heading line or `lines.length`. */
  contentEnd: number;
}

function anchorFor(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~[\]().,!?;:'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Walk the body line-by-line and emit a section range for every heading.
 * Mirrors extractSections in handoff.ts but keeps the line offsets so we
 * can splice instead of re-stringifying the whole doc.
 */
export function sectionRanges(body: string): SectionRange[] {
  const lines = body.split("\n");
  const starts: Array<{ heading: string; anchor: string; level: number; headingLine: number }> = [];
  lines.forEach((line, i) => {
    const match = HEADING_RE.exec(line);
    if (!match) return;
    const level = match[1]!.length;
    const heading = match[2]!.replace(/\s+#+$/, "").trim();
    if (!heading) return;
    starts.push({ heading, anchor: anchorFor(heading), level, headingLine: i });
  });
  return starts.map((section, idx) => ({
    heading: section.heading,
    anchor: section.anchor,
    level: section.level,
    headingLine: section.headingLine,
    contentStart: section.headingLine + 1,
    contentEnd: starts[idx + 1]?.headingLine ?? lines.length,
  }));
}

/**
 * Resolve a needle to a section by exact anchor match, then by case-
 * insensitive heading text. Returns null if nothing matches so the caller
 * can decide what to do (typically return an `anchor_not_found` error with
 * suggested anchors).
 */
export function findRange(ranges: SectionRange[], needle: string): SectionRange | null {
  const target = needle.trim().toLowerCase();
  if (!target) return null;
  return (
    ranges.find((range) => range.anchor === target) ??
    ranges.find((range) => range.heading.toLowerCase() === target) ??
    null
  );
}

export type ReplaceMode = "strict" | "lenient";

export interface ReplaceSectionResult {
  body: string;
  anchor: string;
  /**
   * Optional: when mode === "strict" the caller wants to know if any OTHER
   * section's contents diverged between baseVersion and now. The caller
   * compares this set against the baseline; we just return the spliced body.
   */
  replacedRange: { contentStart: number; contentEnd: number };
}

/**
 * Splice the body so the heading line stays put but its content is replaced
 * with `newContent`. Heading itself is preserved so renames are an explicit
 * separate operation (you'd pageden_rename_section, not replace_section).
 *
 * Returns null if the anchor isn't found — caller surfaces the structured
 * `anchor_not_found` error.
 */
export function replaceSection(body: string, anchor: string, newContent: string): ReplaceSectionResult | null {
  const ranges = sectionRanges(body);
  const target = findRange(ranges, anchor);
  if (!target) return null;
  const lines = body.split("\n");
  const before = lines.slice(0, target.contentStart);
  const after = lines.slice(target.contentEnd);
  // Trim leading + trailing newlines so consecutive splices don't accumulate
  // blank lines. Done char-by-char to stay strictly linear on adversarial
  // input (CodeQL js/polynomial-redos flags /^\n+/ + /\n+$/).
  let startIdx = 0;
  while (startIdx < newContent.length && newContent.charCodeAt(startIdx) === 10) startIdx += 1;
  let endIdx = newContent.length;
  while (endIdx > startIdx && newContent.charCodeAt(endIdx - 1) === 10) endIdx -= 1;
  const normalized = newContent.slice(startIdx, endIdx);
  const spliced = [...before, normalized, ...after];
  return {
    body: spliced.join("\n"),
    anchor: target.anchor,
    replacedRange: { contentStart: target.contentStart, contentEnd: target.contentEnd },
  };
}

/**
 * Suggest the up-to-N closest anchors to a missing needle. Used by the
 * anchor_not_found error message so the caller can pick the right one
 * without a separate read_document call.
 */
export function suggestAnchors(body: string, needle: string, limit = 5): string[] {
  const ranges = sectionRanges(body);
  const target = needle.trim().toLowerCase();
  if (ranges.length === 0) return [];
  // Cheap prefix/substring score so a typo like "decisons" still surfaces
  // "decisions" without dragging in an external Levenshtein dep.
  const scored = ranges.map((range) => {
    const anchor = range.anchor;
    const heading = range.heading.toLowerCase();
    let score = 0;
    if (anchor.startsWith(target) || heading.startsWith(target)) score += 3;
    if (anchor.includes(target) || heading.includes(target)) score += 1;
    return { anchor, heading: range.heading, score };
  });
  scored.sort((a, b) => b.score - a.score || a.anchor.localeCompare(b.anchor));
  // If nothing scored above zero we still hand back the first few anchors so
  // the caller has SOMETHING to choose from.
  const useful = scored.filter((row) => row.score > 0);
  const fallback = useful.length ? useful : scored;
  return fallback.slice(0, limit).map((row) => row.anchor);
}
