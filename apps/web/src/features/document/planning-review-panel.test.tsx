import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { PlanningReviewPanel } from "./planning-review-panel";

const savedContent = `---
status: draft
docType: plan
workflow: multi-agent-planning
workflowStatus: review
reviewRound: 2
leadAgent: agent-a
reviewAgent: agent-b
---

# Agent Plan

## Goal

Ship it.
`;

function renderPanel(options: { enabled?: boolean; hasUnsavedChanges?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PlanningReviewPanel
        documentId="document-1"
        workspaceId="workspace-1"
        enabled={options.enabled ?? true}
        canEdit
        content={savedContent}
        baseVersion="version-1"
        documentStatus="draft"
        hasUnsavedChanges={options.hasUnsavedChanges ?? false}
      />
    </QueryClientProvider>,
  );
}

const packet = {
  workspaceId: "workspace-1",
  documentId: "document-1",
  title: "Agent Plan",
  path: "strategy/agent-plan.md",
  updatedAt: "2026-07-02T08:00:00.000Z",
  packet: {
    summary: "Plan summary.",
    status: "draft" as const,
    supersededBy: null,
    workflow: {
      workflow: "multi-agent-planning",
      workflowStatus: "review",
      reviewRound: 2,
      leadAgent: "agent-a",
      reviewAgent: "agent-b",
    },
    recommendedAction: "comment_only" as const,
    openCommentsBySection: [
      {
        sectionAnchor: "risks",
        count: 1,
        comments: [{ id: "comment-1", body: "Clarify rollback before final review." }],
      },
    ],
    activeClaim: {
      id: "claim-1",
      actorLabel: "Reviewer (agent)",
      note: "Reviewing plan round 2",
      expiresAt: "2026-07-02T08:30:00.000Z",
    },
    currentPhase: null,
    nextSteps: [],
    acceptanceCriteria: ["Reviewer can inspect comments."],
    tests: [],
    nonGoals: [],
    openQuestions: ["Should final promotion require human approval? Blocking."],
    relatedFiles: [],
    decisions: [
      {
        id: "plan-status",
        status: "proposed",
        date: null,
        owner: "agent-a",
        replaces: null,
        decision: "Initial plan drafted.",
        reason: "Review not complete.",
      },
    ],
    prLinks: [],
    implementationReadiness: {
      status: "draft_only" as const,
      score: 70,
      reasons: [],
    },
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanningReviewPanel", () => {
  it("renders workflow status, active claim, comments, and decision state", async () => {
    vi.spyOn(api, "documentHandoff").mockResolvedValue(packet);

    renderPanel();

    expect(await screen.findByText("Comment only")).toBeTruthy();
    expect(screen.getByText("Planning Review")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("agent-a")).toBeTruthy();
    expect(screen.getByText("agent-b")).toBeTruthy();
    expect(screen.getByText("Reviewer (agent)")).toBeTruthy();
    expect(screen.getByText("Reviewing plan round 2")).toBeTruthy();
    expect(screen.getByText("#risks")).toBeTruthy();
    expect(screen.getByText("Clarify rollback before final review.")).toBeTruthy();
    expect(screen.getByText("proposed")).toBeTruthy();
    expect(screen.getByText("plan-status")).toBeTruthy();
    expect(screen.getByText("Not ready to finalize yet.")).toBeTruthy();
  });

  it("does not fetch or render when disabled", () => {
    const handoff = vi.spyOn(api, "documentHandoff").mockResolvedValue(packet);

    renderPanel({ enabled: false });

    expect(screen.queryByText("Planning Review")).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("updates workflow frontmatter with allowDraft for status transitions", async () => {
    vi.spyOn(api, "documentHandoff").mockResolvedValue(packet);
    const update = vi.spyOn(api, "updateDocument").mockResolvedValue({
      id: "document-1",
      version: "version-2",
      checksum: "checksum-2",
      revisionHash: null,
      updatedAt: "2026-07-02T08:05:00.000Z",
    });

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Request revision" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith("document-1", {
        baseVersion: "version-1",
        allowDraft: true,
        content: expect.stringContaining("workflowStatus: revision"),
      });
    });
    expect(update.mock.calls[0]?.[1].content).toContain("reviewRound: 2");
    expect(update.mock.calls[0]?.[1].content).toContain("# Agent Plan");
  });

  it("disables workflow actions while local edits are unsaved", async () => {
    vi.spyOn(api, "documentHandoff").mockResolvedValue(packet);

    renderPanel({ hasUnsavedChanges: true });

    expect(await screen.findByText("Save or discard local edits before changing workflow state.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Request revision" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
