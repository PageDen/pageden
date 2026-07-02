import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivePlanningCard } from "./workspace-dashboard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: () => ({ workspaceId: "workspace-1" }),
}));

afterEach(() => {
  cleanup();
});

describe("ActivePlanningCard", () => {
  it("renders active planning details and document links", () => {
    render(
      <ActivePlanningCard
        workspaceId="workspace-1"
        plans={[
          {
            id: "plan-1",
            title: "Multi Agent Plan",
            path: "strategy/multi-agent-plan.md",
            status: "draft",
            updatedAt: "2026-07-02T09:00:00.000Z",
            workflowStatus: "review",
            reviewRound: 2,
            leadAgent: "Lead Agent",
            reviewAgent: "Review Agent",
            openCommentCount: 3,
            activeClaim: {
              id: "claim-1",
              actorLabel: "Reviewer (agent)",
              note: "Checking open comments",
              expiresAt: "2026-07-02T09:30:00.000Z",
            },
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Active planning (1)" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Multi Agent Plan" });
    expect(link.getAttribute("href")).toBe("/w/workspace-1/p/strategy/multi-agent-plan");
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Round 2")).toBeTruthy();
    expect(screen.getByText("3 open")).toBeTruthy();
    expect(screen.getByText("Lead Lead Agent")).toBeTruthy();
    expect(screen.getByText("Review Review Agent")).toBeTruthy();
    expect(screen.getByText("Claimed by Reviewer (agent): Checking open comments")).toBeTruthy();
  });
});
