import { describe, expect, it } from "vitest";
import { documentContext } from "./ai-readiness.js";

describe("documentContext", () => {
  it("parses frontmatter scalars, arrays, and the markdown body", () => {
    const context = documentContext(`---
title: "Launch Plan"
tags: [alpha, "beta", 'gamma']
ignored line
---
# Overview

See [[Roadmap]] and ![[diagram.png]].
`);

    expect(context.frontmatter).toEqual({
      title: "Launch Plan",
      tags: ["alpha", "beta", "gamma"],
    });
    expect(context.body).toContain("# Overview");
    expect(context.headings).toEqual([{ level: 1, title: "Overview", anchor: "overview" }]);
    expect(context.wikilinks).toEqual(["diagram.png", "Roadmap"]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const context = documentContext(`# Deployment Plan

\`\`\`sh
# shell comment
## not a section
\`\`\`

~~~env
# also not a section
TOKEN=example
~~~

## Real Section
`);

    expect(context.headings).toEqual([
      { level: 1, title: "Deployment Plan", anchor: "deployment-plan" },
      { level: 2, title: "Real Section", anchor: "real-section" },
    ]);
  });

  it("ignores unterminated frontmatter fences", () => {
    const context = documentContext("---\ntitle: Draft\n# Body");

    expect(context.frontmatter).toEqual({});
    expect(context.body).toContain("title: Draft");
  });
});
