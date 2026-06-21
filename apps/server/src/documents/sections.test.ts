import { describe, expect, it } from "vitest";
import { findRange, replaceSection, sectionRanges, suggestAnchors } from "./sections.js";

const SAMPLE = `# Plan

Intro

## Goals

Body one
Body two

## Decisions

A
B

## Notes

Trailing
`;

describe("sectionRanges", () => {
  it("returns one range per heading with contentStart/end line offsets", () => {
    const ranges = sectionRanges(SAMPLE);
    expect(ranges.map((r) => r.anchor)).toEqual(["plan", "goals", "decisions", "notes"]);
    // contentStart is heading line + 1, contentEnd is the next heading line.
    const goals = ranges.find((r) => r.anchor === "goals")!;
    expect(goals.contentStart).toBeLessThan(goals.contentEnd);
    expect(goals.contentEnd).toBe(ranges.find((r) => r.anchor === "decisions")!.headingLine);
  });

  it("the last section runs to EOF", () => {
    const ranges = sectionRanges(SAMPLE);
    const notes = ranges.find((r) => r.anchor === "notes")!;
    expect(notes.contentEnd).toBe(SAMPLE.split("\n").length);
  });

  it("ignores heading-like shell comments inside fenced code blocks", () => {
    const ranges = sectionRanges(`# Plan

\`\`\`sh
# install dependencies
## not a real section
\`\`\`

~~~text
# not a heading either
~~~

## Verification
`);

    expect(ranges.map((r) => r.anchor)).toEqual(["plan", "verification"]);
  });
});

describe("findRange", () => {
  it("matches by anchor exactly then falls back to heading text", () => {
    const ranges = sectionRanges(SAMPLE);
    expect(findRange(ranges, "decisions")?.anchor).toBe("decisions");
    expect(findRange(ranges, "Decisions")?.anchor).toBe("decisions");
    expect(findRange(ranges, "no-such-anchor")).toBeNull();
  });
});

describe("replaceSection", () => {
  it("replaces just the section body, leaving the heading and siblings intact", () => {
    const result = replaceSection(SAMPLE, "decisions", "X\nY\n");
    expect(result).not.toBeNull();
    expect(result!.anchor).toBe("decisions");
    expect(result!.body).toContain("## Decisions\nX\nY\n## Notes");
    expect(result!.body).toContain("## Goals");
    expect(result!.body).toContain("Trailing");
    expect(result!.body).not.toContain("A\nB");
  });

  it("returns null when the anchor does not exist", () => {
    expect(replaceSection(SAMPLE, "missing", "x")).toBeNull();
  });

  it("normalizes leading/trailing newlines so consecutive splices stay tidy", () => {
    const result = replaceSection(SAMPLE, "goals", "\n\n  body  \n\n\n");
    expect(result!.body).not.toMatch(/^[ \t]*\n{3,}/m);
  });
});

describe("suggestAnchors", () => {
  it("returns the closest anchors by prefix/substring match", () => {
    const suggestions = suggestAnchors(SAMPLE, "decis");
    expect(suggestions[0]).toBe("decisions");
  });

  it("falls back to the first few anchors when nothing scores above zero", () => {
    const suggestions = suggestAnchors(SAMPLE, "totally-unrelated-string");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });
});
