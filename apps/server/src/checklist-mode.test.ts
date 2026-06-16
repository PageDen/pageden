import { describe, expect, it } from "vitest";
import { aiReadinessForDocument, documentContext } from "./ai-readiness.js";

// Real ai-readiness has a workspace query for broken wikilinks. Pass an empty
// wikilinks set so the helper short-circuits without touching the DB.
const baseInput = (content: string) => ({
  workspaceId: "ws_skip_db",
  documentId: "doc1",
  status: "canonical" as const,
  title: "Runbook",
  updatedAt: new Date(),
  context: documentContext(content),
});

const EXECUTION_CHECKLIST = `---
checklistMode: execution
---

# Runbook

This is a deliberate execution checklist.

- [x] Done
- [ ] Pending
- [ ] More pending
`;

const PLAIN_TODOS = `# Runbook

This doc has real TODOs.

- TODO: write the section.
- [ ] random open checkbox.
`;

describe("ai-readiness — checklistMode: execution (F15)", () => {
  it("does not fire unresolved_notes on [ ] when checklistMode=execution", async () => {
    const readiness = await aiReadinessForDocument(baseInput(EXECUTION_CHECKLIST));
    const codes = readiness.issues.map((issue) => issue.code);
    expect(codes).not.toContain("unresolved_notes");
  });

  it("still fires unresolved_notes on real TODO tokens with checklistMode=execution", async () => {
    const checklistWithTodo = EXECUTION_CHECKLIST + "\n\nTODO: still flag this.\n";
    const readiness = await aiReadinessForDocument(baseInput(checklistWithTodo));
    const codes = readiness.issues.map((issue) => issue.code);
    expect(codes).toContain("unresolved_notes");
  });

  it("fires unresolved_notes on [ ] when checklistMode is not set (today's behavior)", async () => {
    const readiness = await aiReadinessForDocument(baseInput(PLAIN_TODOS));
    const codes = readiness.issues.map((issue) => issue.code);
    expect(codes).toContain("unresolved_notes");
  });
});
