import { describe, it, expect } from "vitest";
import { documentContext } from "../ai-readiness.js";
import {
  extractDecisions,
  extractPrLinks,
  extractSections,
  findSection,
  implementationReadinessFor,
  taskPacketFor,
} from "./handoff.js";

const PLAN = `---
status: canonical
---

# Migration Plan

This describes how we migrate the workspace search to the new ranking. The change updates the API contract.

## Phase 1: backfill

- Backfill canonical status on all rows
- Update the search ORDER BY
- Update the api-contract documentation

## Acceptance Criteria

- All existing tests pass
- Search returns canonical results first
- Migration applied cleanly on staging

## Tests

- pnpm test
- Integration test for canonicalOnly filter

## Non-goals

- Refactoring the search snippet builder

## Open Questions

- Should drafts also rank above superseded? Blocking.

## Related Files

The implementation touches \`apps/server/src/documents/routes.ts\` and \`apps/server/src/mcp/routes.ts\`.
`;

describe("extractSections", () => {
  it("splits a body into ordered sections with anchors", () => {
    const { body } = documentContext(PLAN);
    const sections = extractSections(body);
    const headings = sections.map((section) => section.heading);
    expect(headings).toContain("Migration Plan");
    expect(headings).toContain("Phase 1: backfill");
    expect(headings).toContain("Acceptance Criteria");
    expect(sections.find((s) => s.heading === "Acceptance Criteria")?.content).toContain("Search returns canonical results first");
  });
});

describe("findSection", () => {
  it("matches by anchor and by case-insensitive heading text", () => {
    const sections = extractSections(documentContext(PLAN).body);
    expect(findSection(sections, "acceptance-criteria")?.heading).toBe("Acceptance Criteria");
    expect(findSection(sections, "Acceptance Criteria")?.heading).toBe("Acceptance Criteria");
    expect(findSection(sections, "missing")).toBeNull();
  });
});

describe("implementationReadinessFor", () => {
  it("short-circuits on superseded status", () => {
    const ctx = documentContext("# Doc");
    const result = implementationReadinessFor({ status: "superseded", context: ctx });
    expect(result.status).toBe("superseded");
    expect(result.score).toBe(0);
    expect(result.reasons[0]?.code).toBe("superseded");
  });

  it("flags missing acceptance criteria as a warning, not blocking", () => {
    const ctx = documentContext("# Doc\n\nSome text.");
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.reasons.some((r) => r.code === "missing_acceptance_criteria")).toBe(true);
    expect(result.reasons.some((r) => r.code === "missing_next_pr_scope")).toBe(true);
    expect(result.score).toBeLessThan(100);
    expect(result.status).not.toBe("has_blocking_questions");
  });

  it("returns has_blocking_questions when an open question mentions blocking", () => {
    const ctx = documentContext(PLAN);
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.status).toBe("has_blocking_questions");
  });

  it("returns needs_contract_update when the doc mentions api contract changes", () => {
    const doc = PLAN.replace("- Should drafts also rank above superseded? Blocking.", "- All resolved.");
    const ctx = documentContext(doc);
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.status).toBe("needs_contract_update");
  });

  it("does not require contract work when the document confirms the contract is updated", () => {
    const doc = PLAN.replace("- Should drafts also rank above superseded? Blocking.", "- All resolved.").replace(
      "- Update the api-contract documentation",
      "- Update the api-contract documentation\n- API contract updated",
    );
    const ctx = documentContext(doc);
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.reasons.some((r) => r.code === "contract_update_needed")).toBe(false);
  });

  it("uses unresolved reviewer comments as implementation readiness signals", () => {
    const ctx = documentContext(`# Plan

## Acceptance Criteria

- Done

## Tests

- pnpm test

## Next PR Scope

- Update the route only.
`);
    const result = implementationReadinessFor({
      status: "canonical",
      context: ctx,
      comments: [{ body: "Needs API contract update", sectionAnchor: "acceptance-criteria" }],
    });
    expect(result.status).toBe("needs_contract_update");
    expect(result.reasons.some((r) => r.code === "unresolved_contract_comment")).toBe(true);
  });
});

describe("taskPacketFor", () => {
  it("extracts the structured pieces an agent needs to start work", () => {
    const ctx = documentContext(PLAN);
    const packet = taskPacketFor({ status: "canonical", supersededBy: null, context: ctx });
    expect(packet.summary).toMatch(/migrate the workspace search/);
    expect(packet.currentPhase).toBe("Phase 1: backfill");
    expect(packet.acceptanceCriteria).toContain("Search returns canonical results first");
    expect(packet.tests).toContain("pnpm test");
    expect(packet.nonGoals).toContain("Refactoring the search snippet builder");
    expect(packet.openQuestions[0]).toMatch(/Should drafts/);
    expect(packet.relatedFiles).toContain("apps/server/src/documents/routes.ts");
    expect(packet.implementationReadiness.status).toBe("has_blocking_questions");
    expect(packet.implementationReadiness.score).toEqual(expect.any(Number));
  });
});

const DECISION_DOC = `# Plan

:::decision
id: history-diff-baseline
status: accepted
date: 2026-06-14
owner: product
replaces: previous-current-version-diff

decision: Default history diff compares the selected revision against the previous older revision.
reason: This answers "what changed in this save?" and matches Outline/Docmost behavior.
:::

See https://github.com/PageDen/pageden-cloud/pull/37 and https://github.com/PageDen/pageden/issues/12 for the rollout.
`;

describe("extractDecisions", () => {
  it("parses :::decision blocks into structured records", () => {
    const ctx = documentContext(DECISION_DOC);
    const decisions = extractDecisions(ctx.body);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: "history-diff-baseline",
      status: "accepted",
      date: "2026-06-14",
      owner: "product",
      replaces: "previous-current-version-diff",
    });
    expect(decisions[0]?.decision).toMatch(/Default history diff/);
    expect(decisions[0]?.reason).toMatch(/Outline\/Docmost/);
  });

  it("returns an empty list when no fences are present", () => {
    expect(extractDecisions("# Just a doc")).toEqual([]);
  });
});

describe("extractPrLinks", () => {
  it("pulls github PR/issue links from the body and frontmatter", () => {
    const ctx = documentContext(DECISION_DOC);
    const links = extractPrLinks(ctx.body, { prLinks: ["https://github.com/PageDen/pageden-cloud/pull/38"] });
    expect(links).toContain("https://github.com/PageDen/pageden-cloud/pull/37");
    expect(links).toContain("https://github.com/PageDen/pageden/issues/12");
    expect(links).toContain("https://github.com/PageDen/pageden-cloud/pull/38");
  });
});
