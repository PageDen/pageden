import { describe, expect, it } from "vitest";
import { extractHeadings } from "./table-of-contents";

describe("extractHeadings", () => {
  it("extracts headings outside fenced code blocks", () => {
    expect(extractHeadings("# Title\n\n## Scope ###\n")).toEqual([
      { level: 1, text: "Title", id: "title" },
      { level: 2, text: "Scope", id: "scope" },
    ]);
  });

  it("ignores heading-like shell comments inside fenced code blocks", () => {
    const headings = extractHeadings(`# Deployment Plan

\`\`\`sh
# install dependencies
## not a page section
\`\`\`

~~~env
# TOKEN placeholder
~~~

## Verification
`);

    expect(headings).toEqual([
      { level: 1, text: "Deployment Plan", id: "deployment-plan" },
      { level: 2, text: "Verification", id: "verification" },
    ]);
  });
});
