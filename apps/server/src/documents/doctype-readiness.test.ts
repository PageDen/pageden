import { describe, expect, it } from "vitest";
import { documentContext } from "../ai-readiness.js";
import { implementationReadinessFor } from "./handoff.js";

const OPERATIONAL = `---
docType: operational
---

# Runbook

## Process

- [x] Wake up
- [ ] Daily standup
- [ ] Deploy

## Notes

Trailing prose.
`;

const PLAN = `---
docType: plan
---

# Plan

## Acceptance Criteria

- ship
- test

## Tests

- unit

## Non-goals

- redesign
`;

const IMPLEMENTATION_MISSING_FIELDS = `---
docType: implementation
---

# Implementation
`;

describe("implementationReadinessFor — docType awareness (F15)", () => {
  it("returns not_applicable on non-implementation docTypes without firing missing_acceptance_criteria", () => {
    const ctx = documentContext(OPERATIONAL);
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.status).toBe("not_applicable");
    expect(result.score).toBe(100);
    expect(result.reasons.map((r) => r.code)).toEqual(["doctype_not_applicable"]);
  });

  it("still runs the checks on docType=plan or docType=implementation", () => {
    const ctxPlan = documentContext(PLAN);
    const planResult = implementationReadinessFor({ status: "canonical", context: ctxPlan });
    expect(planResult.status).not.toBe("not_applicable");
    expect(planResult.score).toBeGreaterThan(50);

    const ctxImpl = documentContext(IMPLEMENTATION_MISSING_FIELDS);
    const implResult = implementationReadinessFor({ status: "canonical", context: ctxImpl });
    expect(implResult.status).not.toBe("not_applicable");
    expect(implResult.reasons.some((r) => r.code === "missing_acceptance_criteria")).toBe(true);
  });

  it("treats missing docType as today's behavior (runs the implementation checks)", () => {
    const ctx = documentContext(IMPLEMENTATION_MISSING_FIELDS.replace(/docType: implementation\n/, ""));
    const result = implementationReadinessFor({ status: "canonical", context: ctx });
    expect(result.status).not.toBe("not_applicable");
  });
});
