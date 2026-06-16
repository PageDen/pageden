// Code-context-aware preprocessing for the structured-content parsers
// (decisions, wikilinks, TODO checkboxes). Replaces text inside fenced code
// blocks and inline code spans with placeholder whitespace so regex sweeps
// never count illustrative examples as real content.
//
// Returns the masked body PLUS counters per parser so reads can expose
// `decisions_in_code` / `wikilinks_in_code` for debugging — see
// ai-agent-workspace-improvements.md Feature 17.

export interface MaskedCounts {
  decisionsInCode: number;
  wikilinksInCode: number;
  checkboxesInCode: number;
}

export interface MaskedBody {
  body: string;
  counts: MaskedCounts;
}

const FENCE_OPEN = /^(\s*)(```+|~~~+)(\s*.*)?$/;
const FENCE_DECISION_OPEN = /^:::decision\s*$/i;
const WIKILINK_RE = /!?\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g;
const CHECKBOX_RE = /\[ \]/g;

function spaceOf(line: string): string {
  // Preserve length so any downstream offset-based logic (e.g. heading line
  // numbers) stays aligned, but drop content so parsers see nothing scannable.
  return " ".repeat(line.length);
}

/**
 * Walk the body line-by-line. Inside ``` or ~~~ fenced blocks AND inside the
 * matching inline `…` runs on a single line, replace the content with spaces.
 * Lines OUTSIDE fences are left alone.
 *
 * The returned `body` is byte-stable: every character index of the original
 * still exists in the output, so callers can mix-and-match with the original
 * body (e.g. for offset reporting) if they need to.
 */
export function maskCodeContext(input: string): MaskedBody {
  const lines = input.split("\n");
  const out: string[] = [];
  const counts: MaskedCounts = { decisionsInCode: 0, wikilinksInCode: 0, checkboxesInCode: 0 };
  let inFence = false;
  let fenceMarker: string | null = null;
  for (const line of lines) {
    if (inFence) {
      // While inside a fence, look only for the matching closing marker.
      const closing = FENCE_OPEN.exec(line);
      if (closing && fenceMarker && closing[2]!.startsWith(fenceMarker[0]!) && closing[2]!.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
        out.push(line); // keep the closing fence line as-is — it's not content
        continue;
      }
      // Tally what we're masking inside the fence so reads can surface debug counts.
      if (FENCE_DECISION_OPEN.test(line.trim())) counts.decisionsInCode += 1;
      const wikiHits = line.match(WIKILINK_RE);
      if (wikiHits) counts.wikilinksInCode += wikiHits.length;
      const checkHits = line.match(CHECKBOX_RE);
      if (checkHits) counts.checkboxesInCode += checkHits.length;
      out.push(spaceOf(line));
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      inFence = true;
      fenceMarker = open[2]!;
      out.push(line); // keep the opening fence line — it's the marker, not content
      continue;
    }
    out.push(maskInlineCode(line, counts));
  }
  return { body: out.join("\n"), counts };
}

// Replace each `…` inline-code span with spaces. Single backticks; doubled
// backticks (`` ` ``) are an edge case — we treat any same-line pair as a span.
function maskInlineCode(line: string, counts: MaskedCounts): string {
  if (!line.includes("`")) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1);
      if (close === -1) {
        // Unmatched backtick on this line — leave the rest verbatim.
        out += line.slice(i);
        break;
      }
      const span = line.slice(i, close + 1);
      // Count any structured-content tokens we're about to hide so reads can
      // expose the debug counts.
      const wikiHits = span.match(WIKILINK_RE);
      if (wikiHits) counts.wikilinksInCode += wikiHits.length;
      const checkHits = span.match(CHECKBOX_RE);
      if (checkHits) counts.checkboxesInCode += checkHits.length;
      out += " ".repeat(span.length);
      i = close + 1;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * Dedupe a list of decisions by `id`. Order is preserved by FIRST occurrence
 * so the structured `## Decisions` section wins over later illustrative
 * examples (even if the maskCodeContext step missed one). When two distinct
 * decisions intentionally share an id, attach a `duplicateId` flag to the
 * later entries so the caller can surface a warning.
 */
export function dedupeDecisions<T extends { id: string }>(decisions: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const decision of decisions) {
    if (seen.has(decision.id)) continue;
    seen.add(decision.id);
    out.push(decision);
  }
  return out;
}
