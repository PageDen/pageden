import { describe, expect, it } from "vitest";
import { dedupeDecisions, maskCodeContext } from "./markdown-context.js";

describe("maskCodeContext", () => {
  it("masks content inside triple-backtick fenced blocks but keeps the fence markers", () => {
    const input = `Real text [[real-link]]
\`\`\`
Inside fence [[fake-link]]
\`\`\`
Tail text [[another-real]]`;
    const result = maskCodeContext(input);
    // The wikilink inside the fence is masked, the ones outside survive.
    expect(result.body).toContain("[[real-link]]");
    expect(result.body).not.toContain("[[fake-link]]");
    expect(result.body).toContain("[[another-real]]");
    // Fence open/close markers are preserved verbatim.
    expect(result.body).toContain("```");
    expect(result.counts.wikilinksInCode).toBe(1);
  });

  it("masks tilde fences and tracks decision blocks inside them", () => {
    const input = `~~~markdown
:::decision
id: example-id
status: accepted

decision: Drop on the floor.
:::
~~~`;
    const result = maskCodeContext(input);
    expect(result.counts.decisionsInCode).toBe(1);
    // The :::decision opening line should no longer be visible to a downstream parser.
    expect(result.body).not.toContain(":::decision");
  });

  it("masks inline backtick code spans within a single line", () => {
    const input = "See `[[fake]]` but [[real]] survives.";
    const result = maskCodeContext(input);
    expect(result.body).toContain("[[real]]");
    expect(result.body).not.toContain("[[fake]]");
    expect(result.counts.wikilinksInCode).toBe(1);
  });

  it("counts checkboxes inside code fences without flagging them", () => {
    const input = `Body
\`\`\`
- [ ] example task
\`\`\`
Real - [ ] task here.`;
    const result = maskCodeContext(input);
    expect(result.counts.checkboxesInCode).toBe(1);
    // Real checkbox survives in the body.
    expect(result.body).toMatch(/Real - \[ \] task here/);
  });

  it("preserves character offsets so heading line numbers stay aligned", () => {
    const input = `Line one
\`\`\`
fenced content stays as spaces
\`\`\`
Line four`;
    const result = maskCodeContext(input);
    expect(result.body.split("\n").length).toBe(input.split("\n").length);
    expect(result.body.split("\n")[2]!.length).toBe("fenced content stays as spaces".length);
  });
});

describe("dedupeDecisions", () => {
  it("keeps the first occurrence per id", () => {
    const result = dedupeDecisions([
      { id: "a", note: "first" },
      { id: "b", note: "second" },
      { id: "a", note: "duplicate" },
    ]);
    expect(result.map((d) => d.note)).toEqual(["first", "second"]);
  });
});
