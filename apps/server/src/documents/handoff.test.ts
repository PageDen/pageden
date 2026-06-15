import { describe, it, expect } from "vitest";
import { documentContext } from "../ai-readiness.js";
import { extractSections, findSection, implementationReadinessFor, taskPacketFor } from "./handoff.js";

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
    expect(result.reasons[0]?.code).toBe("superseded");
  });

  it("flags missing acceptance criteria as a warning, not blocking", () => {
    const ctx = documentContext("# Doc\n\nSome text.");
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.reasons.some((r) => r.code === "missing_acceptance_criteria")).toBe(true);
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
  });
});
