import { describe, expect, it } from "vitest";
import { renderDecisionBlocks } from "./decision-blocks";

const SAMPLE = `# Plan

Some intro prose.

:::decision
id: history-diff-baseline
status: accepted
date: 2026-06-14
owner: product

decision: Default history diff compares the selected revision against the previous older revision.
reason: Matches Outline/Docmost behavior.
:::

More prose between decisions.

:::decision
id: keyboard-shortcut
status: proposed
owner: web

decision: Add cmd+shift+H to open history.
:::

## Notes

Trailing notes.
`;

describe("renderDecisionBlocks", () => {
  it("returns the decision count and converts fences into aside HTML", () => {
    const result = renderDecisionBlocks(SAMPLE);
    expect(result.count).toBe(2);
    expect(result.body).toContain('class="decision-block');
    expect(result.body).toContain("history-diff-baseline");
    expect(result.body).toContain("Matches Outline/Docmost behavior.");
    // Non-decision prose is preserved.
    expect(result.body).toContain("Some intro prose.");
    expect(result.body).toContain("## Notes");
  });

  it("in decisionsOnly mode drops everything except the decision asides plus a header", () => {
    const result = renderDecisionBlocks(SAMPLE, { decisionsOnly: true });
    expect(result.count).toBe(2);
    expect(result.body.startsWith("## Decisions (2)")).toBe(true);
    expect(result.body).toContain("history-diff-baseline");
    expect(result.body).toContain("keyboard-shortcut");
    // Non-decision prose is removed.
    expect(result.body).not.toContain("Some intro prose.");
    expect(result.body).not.toContain("Trailing notes.");
    expect(result.body).not.toContain("## Notes");
  });

  it("escapes user-provided text to prevent HTML injection", () => {
    const malicious = `:::decision
id: bad<script>alert(1)</script>
status: accepted

decision: <img src=x onerror=alert(1)>
:::`;
    const result = renderDecisionBlocks(malicious);
    expect(result.count).toBe(1);
    // Both raw tag tokens must be escaped — the substrings `onerror=` and
    // `alert(1)` can still appear, they just need to be text, not markup.
    expect(result.body).toContain("&lt;script&gt;");
    expect(result.body).toContain("&lt;img");
    expect(result.body).not.toMatch(/<script[\s>]/i);
    expect(result.body).not.toMatch(/<img[\s>]/i);
  });

  it("returns count=0 and the body untouched when no decision blocks exist", () => {
    const plain = "# Title\n\nJust prose, no decisions here.\n";
    const result = renderDecisionBlocks(plain);
    expect(result.count).toBe(0);
    expect(result.body).toBe(plain);
  });

  it("decisionsOnly shows a friendly placeholder when no decisions exist", () => {
    const plain = "# Title\n\nJust prose, no decisions here.\n";
    const result = renderDecisionBlocks(plain, { decisionsOnly: true });
    expect(result.count).toBe(0);
    expect(result.body).toContain("## Decisions");
    expect(result.body).toContain("No structured");
  });
});
