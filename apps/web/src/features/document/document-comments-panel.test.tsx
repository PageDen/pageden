import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { DocumentCommentsPanel } from "./document-comments-panel";

const openComment = {
  id: "comment-1",
  workspaceId: "workspace-1",
  documentId: "document-1",
  sectionAnchor: "summary",
  body: "Needs one more review.",
  authorUserId: "user-1",
  authorTokenId: null,
  authorLabel: "Chris",
  resolvedAt: null,
  resolvedById: null,
  mentionedUserIds: ["user-2"],
  createdAt: "2026-06-28T09:00:00.000Z",
  updatedAt: "2026-06-28T09:00:00.000Z",
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DocumentCommentsPanel documentId="document-1" compact />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DocumentCommentsPanel", () => {
  it("highlights inline mentions without duplicating mention chips", async () => {
    vi.spyOn(api, "documentComments").mockResolvedValue({
      comments: [{ ...openComment, body: "Needs @Reviewer one more review." }],
    });
    vi.spyOn(api, "documentCommentMentionUsers").mockResolvedValue({
      users: [{ id: "user-2", email: "reviewer@example.com", name: "Reviewer" }],
    });

    renderPanel();

    const inlineMention = await screen.findByText("@Reviewer");
    expect(inlineMention.className).toContain("text-orange-700");
    expect(screen.getAllByText("@Reviewer")).toHaveLength(1);
  });

  it("shows open comments and posts new comments with @ mention autocomplete", async () => {
    const comments = vi.spyOn(api, "documentComments").mockResolvedValue({ comments: [openComment] });
    vi.spyOn(api, "documentCommentMentionUsers").mockResolvedValue({
      users: [{ id: "user-2", email: "reviewer@example.com", name: "Reviewer" }],
    });
    const add = vi.spyOn(api, "addDocumentComment").mockResolvedValue({ comment: { ...openComment, id: "comment-2", body: "New note" } });

    renderPanel();

    expect(await screen.findByText("Needs one more review.")).toBeTruthy();
    expect(screen.getByText("#summary")).toBeTruthy();
    expect(screen.getByText("@Reviewer")).toBeTruthy();

    const textarea = screen.getByPlaceholderText("Add a comment...");
    fireEvent.change(textarea, { target: { value: "New note @Rev", selectionStart: 13 } });
    fireEvent.click(await screen.findByRole("button", { name: /Reviewer/ }));
    expect((textarea as HTMLTextAreaElement).value).toBe("New note @Reviewer ");
    fireEvent.change(screen.getByPlaceholderText("section anchor (optional)"), { target: { value: "details" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));

    await waitFor(() => {
      expect(add).toHaveBeenCalledWith("document-1", {
        body: "New note @Reviewer",
        sectionAnchor: "details",
        mentionedUserIds: ["user-2"],
      });
    });
    expect(comments).toHaveBeenCalledWith("document-1");
  });

  it("posts manually typed exact @ mentions as notification recipients", async () => {
    vi.spyOn(api, "documentComments").mockResolvedValue({ comments: [] });
    vi.spyOn(api, "documentCommentMentionUsers").mockResolvedValue({
      users: [{ id: "user-2", email: "reviewer@example.com", name: "Reviewer" }],
    });
    const add = vi.spyOn(api, "addDocumentComment").mockResolvedValue({ comment: { ...openComment, id: "comment-2", body: "Manual @Reviewer" } });

    renderPanel();

    const textarea = screen.getByPlaceholderText("Add a comment...");
    fireEvent.change(textarea, { target: { value: "Manual @Rev", selectionStart: 11 } });
    await screen.findByRole("button", { name: /Reviewer/ });
    fireEvent.change(textarea, { target: { value: "Manual @Reviewer", selectionStart: 16 } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));

    await waitFor(() => {
      expect(add).toHaveBeenCalledWith("document-1", {
        body: "Manual @Reviewer",
        sectionAnchor: null,
        mentionedUserIds: ["user-2"],
      });
    });
  });
});
