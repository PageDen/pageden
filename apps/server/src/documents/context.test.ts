import { describe, expect, it } from "vitest";
import { documentContext } from "../ai-readiness.js";

describe("documentContext", () => {
  it("extracts wikilinks from multiline frontmatter arrays", () => {
    const context = documentContext(`---
status: canonical
relatedDocs:
  - "[[permission-model-review-outline-docmost]]"
  - "[[ai-agent-workspace-improvements]]"
---

# Body

See [[body-link]].
`);

    expect(context.frontmatter.relatedDocs).toEqual([
      "[[permission-model-review-outline-docmost]]",
      "[[ai-agent-workspace-improvements]]",
    ]);
    expect(context.wikilinks).toEqual([
      "ai-agent-workspace-improvements",
      "body-link",
      "permission-model-review-outline-docmost",
    ]);
  });
});
