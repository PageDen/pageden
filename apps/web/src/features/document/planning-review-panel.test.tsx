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

function renderPanel(options: { enabled?: boolean; hasUnsavedChanges?: boolean; documentStatus?: "canonical" | "draft" | "superseded" | "archived" } = {}) {
  vi.spyOn(api, "documentHistory").mockResolvedValue(history);
  vi.spyOn(api, "documentDiff").mockResolvedValue(diff);
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
        documentStatus={options.documentStatus ?? "draft"}
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

const history = {
  revisions: [
    {
      id: "version-2",
      versionNumber: 2,
      checksum: "checksum-2",
      createdBy: "user-1",
      createdAt: "2026-07-02T08:05:00.000Z",
      changeSource: "agent" as const,
      message: null,
      contributorIds: ["user-1"],
      isPinned: false,
      label: null,
      groupId: "version-2",
      groupCount: 1,
      groupStartVersionNumber: 2,
      groupEndVersionNumber: 2,
      collapsedRevisions: [],
    },
    {
      id: "version-1",
      versionNumber: 1,
      checksum: "checksum-1",
      createdBy: "user-1",
      createdAt: "2026-07-02T08:00:00.000Z",
      changeSource: "web_app" as const,
      message: null,
      contributorIds: ["user-1"],
      isPinned: false,
      label: null,
      groupId: "version-1",
      groupCount: 1,
      groupStartVersionNumber: 1,
      groupEndVersionNumber: 1,
      collapsedRevisions: [],
    },
  ],
  timeline: [
    {
      type: "event" as const,
      id: "event-1",
      createdAt: "2026-07-02T08:06:00.000Z",
      event: {
        action: "document_plan_reviewed_by_agent",
        actor: "agent" as const,
        userId: "user-1",
        targetType: "document",
        targetId: "document-1",
        metadata: null,
      },
    },
    {
      type: "event" as const,
      id: "event-2",
      createdAt: "2026-07-02T08:05:30.000Z",
      event: {
        action: "document_updated_by_agent",
        actor: "agent" as const,
        userId: "user-1",
        targetType: "document",
        targetId: "document-1",
        metadata: { tokenId: "agent-token-1" },
      },
    },
    {
      type: "event" as const,
      id: "event-3",
      createdAt: "2026-07-02T08:05:15.000Z",
      event: {
        action: "document_updated_by_agent",
        actor: "agent" as const,
        userId: "user-1",
        targetType: "document",
        targetId: "document-1",
        metadata: { tokenId: "agent-token-1" },
      },
    },
  ],
};

const diff = {
  documentId: "document-1",
  fromVersion: "version-1",
  toVersion: "version-2",
  unified: "--- a/document-1@version-1\n+++ b/document-1@version-2\n Goal\n-Old step\n+Added step",
  added: 1,
  removed: 1,
  unchanged: 1,
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
    expect(await screen.findByText("Latest changes")).toBeTruthy();
    expect(await screen.findByText("Added step")).toBeTruthy();
    expect(screen.getByText("Review activity")).toBeTruthy();
    expect(screen.getByText("Agent submitted planning review")).toBeTruthy();
    expect(screen.getByText("Agent edited document")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
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

  it("adds an accepted final decision when review blockers are clear", async () => {
    const readyPacket = {
      ...packet,
      packet: {
        ...packet.packet,
        recommendedAction: "human_review" as const,
        openCommentsBySection: [],
        openQuestions: [],
        decisions: [],
      },
    };
    vi.spyOn(api, "documentHandoff").mockResolvedValue(readyPacket);
    const addDecision = vi.spyOn(api, "addDecision").mockResolvedValue({
      id: "document-1",
      version: "version-2",
      checksum: "checksum-2",
      updatedAt: "2026-07-02T08:05:00.000Z",
      decision: {
        id: "final-plan",
        status: "accepted",
        date: null,
        owner: "agent-a",
        replaces: null,
        decision: "This plan is accepted as the current source of truth.",
        reason: "Review comments were resolved and remaining open questions were handled or deferred.",
      },
    });

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Add accepted final decision" }));

    await waitFor(() => {
      expect(addDecision).toHaveBeenCalledWith("document-1", {
        baseVersion: "version-1",
        id: "final-plan",
        status: "accepted",
        owner: "agent-a",
        decision: "This plan is accepted as the current source of truth.",
        reason: "Review comments were resolved and remaining open questions were handled or deferred.",
        allowDraft: true,
      });
    });
  });

  it("does not show promotion controls after an accepted plan is canonical", async () => {
    const acceptedPacket = {
      ...packet,
      packet: {
        ...packet.packet,
        status: "canonical" as const,
        workflow: {
          ...packet.packet.workflow,
          workflowStatus: "accepted",
        },
        recommendedAction: "finalize" as const,
        openCommentsBySection: [],
        openQuestions: [],
        decisions: [
          {
            id: "final-plan",
            status: "accepted",
            date: null,
            owner: "agent-a",
            replaces: null,
            decision: "Accepted.",
            reason: "Ready.",
          },
        ],
      },
    };
    vi.spyOn(api, "documentHandoff").mockResolvedValue(acceptedPacket);

    renderPanel({ documentStatus: "canonical" });

    expect(await screen.findByText("Canonical plan is accepted.")).toBeTruthy();
    expect(screen.queryByText("Ready for canonical promotion.")).toBeNull();
    expect(screen.queryByText("Finalize")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add accepted final decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark canonical" })).toBeNull();
    expect(screen.getByRole("button", { name: "Request revision" })).toBeTruthy();
  });
});
