import { describe, expect, it } from "vitest";
import { frontmatterTitle, parseFrontmatter } from "./frontmatter";

describe("frontmatter parsing", () => {
  it("extracts attributes and leaves the Markdown body ready for preview", () => {
    const parsed = parseFrontmatter(`---
title: Runbook
draft: false
priority: 3
tags: [ops, incident]
owners:
  - Chris
  - Team
---
# Body

Hello`);

    expect(parsed.attributes).toEqual({
      title: "Runbook",
      draft: false,
      priority: 3,
      tags: ["ops", "incident"],
      owners: ["Chris", "Team"],
    });
    expect(parsed.body).toBe("# Body\n\nHello");
    expect(frontmatterTitle(parsed.raw ? `---\n${parsed.raw}\n---\n${parsed.body}` : "")).toBe("Runbook");
  });

  it("keeps ordinary Markdown unchanged", () => {
    const parsed = parseFrontmatter("# No metadata\n\nJust text.");
    expect(parsed.attributes).toEqual({});
    expect(parsed.body).toBe("# No metadata\n\nJust text.");
    expect(parsed.raw).toBeNull();
  });

  it("ignores an unclosed frontmatter block", () => {
    const markdown = "---\ntitle: Broken\n# Body";
    expect(parseFrontmatter(markdown)).toEqual({ attributes: {}, body: markdown, raw: null });
  });
});
