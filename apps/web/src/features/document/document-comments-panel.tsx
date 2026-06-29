import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Trash2 } from "lucide-react";
import type { z } from "zod";
import type { documentCommentSchema } from "@pageden/api-types";
import { api } from "../../lib/api";
import { documentCommentMentionUsersQuery, documentCommentsQuery } from "../../lib/queries";
import { Button } from "../../components/ui/button";

type DocumentComment = z.infer<typeof documentCommentSchema>;
type MentionCandidate = { id: string; email: string; name: string };
type SelectedMention = { id: string; label: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionLabel(user: MentionCandidate): string {
  return user.name || user.email;
}

function activeMentionFor(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
  if (!match) return null;
  return { start: beforeCaret.length - match[2]!.length - 1, query: match[2]! };
}

function mentionBadgesFor(comment: DocumentComment, labels: Map<string, string>): string[] {
  return comment.mentionedUserIds
    .map((userId) => labels.get(userId) ?? "mentioned user")
    .filter((label) => !comment.body.includes(`@${label}`));
}

function mentionedUserIdsForBody(body: string, selectedMentions: SelectedMention[], mentionCandidates: MentionCandidate[]): string[] {
  const ids = new Set<string>();
  for (const mention of selectedMentions) {
    if (body.includes(`@${mention.label}`)) ids.add(mention.id);
  }
  for (const user of mentionCandidates) {
    const label = mentionLabel(user);
    if (label && body.includes(`@${label}`)) ids.add(user.id);
  }
  return [...ids];
}

function renderCommentBody(comment: DocumentComment, labels: Map<string, string>) {
  const labelsToHighlight = comment.mentionedUserIds
    .map((userId) => labels.get(userId))
    .filter((label): label is string => Boolean(label))
    .sort((a, b) => b.length - a.length);
  if (labelsToHighlight.length === 0) return comment.body;

  const mentionPattern = new RegExp(`@(${labelsToHighlight.map(escapeRegExp).join("|")})`, "g");
  const parts: Array<string | { label: string }> = [];
  let lastIndex = 0;
  for (const match of comment.body.matchAll(mentionPattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(comment.body.slice(lastIndex, match.index));
    parts.push({ label: match[0]! });
    lastIndex = match.index + match[0]!.length;
  }
  if (lastIndex < comment.body.length) parts.push(comment.body.slice(lastIndex));

  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <span key={`${part.label}-${index}`} className="font-semibold text-orange-700 dark:text-orange-200">
        {part.label}
      </span>
    ),
  );
}

export function DocumentCommentsPanel({ documentId, compact = false }: { documentId: string; compact?: boolean }) {
  const queryClient = useQueryClient();
  const comments = useQuery(documentCommentsQuery(documentId));
  const mentionUsers = useQuery({ ...documentCommentMentionUsersQuery(documentId), enabled: documentId !== "" });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState("");
  const [caret, setCaret] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<SelectedMention[]>([]);
  const activeMention = useMemo(() => activeMentionFor(body, caret), [body, caret]);
  const add = useMutation({
    mutationFn: () =>
      api.addDocumentComment(documentId, {
        body: body.trim(),
        sectionAnchor: anchor.trim() || null,
        mentionedUserIds: mentionedUserIdsForBody(body, selectedMentions, mentionCandidates),
      }),
    onSuccess: async () => {
      setBody("");
      setAnchor("");
      setCaret(0);
      setSelectedMentions([]);
      await queryClient.invalidateQueries({ queryKey: documentCommentsQuery(documentId).queryKey });
    },
  });
  const resolve = useMutation({
    mutationFn: (commentId: string) => api.resolveComment(commentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: documentCommentsQuery(documentId).queryKey }),
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => api.deleteComment(commentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: documentCommentsQuery(documentId).queryKey }),
  });

  const list = (comments.data?.comments ?? []) as DocumentComment[];
  const open = list.filter((comment) => !comment.resolvedAt);
  const mentionCandidates = mentionUsers.data?.users ?? [];
  const mentionedLabels = new Map(mentionCandidates.map((user) => [user.id, user.name || user.email]));
  const mentionOptions = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    return mentionCandidates
      .filter((user) => {
        const label = mentionLabel(user).toLowerCase();
        return label.includes(query) || user.email.toLowerCase().includes(query);
      })
      .slice(0, 6);
  }, [activeMention, mentionCandidates]);
  const showMentionMenu = Boolean(activeMention && mentionOptions.length > 0);

  function updateBody(value: string, selectionStart: number | null) {
    setBody(value);
    setCaret(selectionStart ?? value.length);
  }

  function insertMention(user: MentionCandidate) {
    if (!activeMention) return;
    const label = mentionLabel(user);
    const replacement = `@${label} `;
    const nextBody = `${body.slice(0, activeMention.start)}${replacement}${body.slice(caret)}`;
    const nextCaret = activeMention.start + replacement.length;
    setBody(nextBody);
    setCaret(nextCaret);
    setSelectedMentions((current) => [...current.filter((mention) => mention.id !== user.id), { id: user.id, label }]);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return (
    <section className={compact ? "my-7 border-y border-slate-200 py-5 dark:border-slate-800" : "rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"}>
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <MessageSquare size={13} aria-hidden="true" />
        Comments
        <span className="ml-auto text-slate-400">{open.length}</span>
      </h2>
      {comments.isLoading ? (
        <p className="text-sm text-slate-400">Loading comments...</p>
      ) : open.length === 0 ? (
        <p className="text-sm italic text-slate-400 dark:text-slate-500">No open comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {open.map((comment) => {
            const mentionBadges = mentionBadgesFor(comment, mentionedLabels);
            return (
              <li key={comment.id} id={`comment-${comment.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">{comment.authorLabel ?? "Someone"}</span>
                  {comment.sectionAnchor ? (
                    <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-200 dark:ring-slate-800">
                      #{comment.sectionAnchor}
                    </code>
                  ) : null}
                  <time dateTime={comment.createdAt}>· {new Date(comment.createdAt).toLocaleString()}</time>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">{renderCommentBody(comment, mentionedLabels)}</p>
                {mentionBadges.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {mentionBadges.map((label) => (
                      <span key={label} className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:bg-orange-500/15 dark:text-orange-200">
                        @{label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <Button variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => resolve.mutate(comment.id)} disabled={resolve.isPending}>
                    <Check size={12} aria-hidden="true" />
                    Resolve
                  </Button>
                  <Button variant="ghost" className="h-7 gap-1 px-2 text-xs text-red-600" onClick={() => remove.mutate(comment.id)} disabled={remove.isPending}>
                    <Trash2 size={12} aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!body.trim()) return;
          add.mutate();
        }}
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => updateBody(event.target.value, event.target.selectionStart)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          rows={compact ? 3 : 4}
          maxLength={4000}
          placeholder="Add a comment..."
          className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm leading-6 text-slate-900 placeholder:text-slate-400 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {showMentionMenu ? (
          <div className="-mt-1 max-h-44 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg dark:border-slate-800 dark:bg-slate-950">
            {mentionOptions.map((user) => (
              <button
                key={user.id}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-slate-700 hover:bg-orange-50 hover:text-orange-800 dark:text-slate-200 dark:hover:bg-orange-500/10 dark:hover:text-orange-100"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(user)}
              >
                <span className="shrink-0 font-semibold text-orange-700 dark:text-orange-200">@</span>
                <span className="min-w-0 flex-1 truncate">{mentionLabel(user)}</span>
                <span className="min-w-0 truncate text-slate-400">{user.email}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            value={anchor}
            onChange={(event) => setAnchor(event.target.value)}
            placeholder="section anchor (optional)"
            maxLength={200}
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400 focus:border-orange-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <Button type="submit" className="shrink-0" disabled={add.isPending || !body.trim()}>
            {add.isPending ? "Adding..." : "Post"}
          </Button>
        </div>
        {add.error ? <p className="text-xs text-red-600">Could not post comment.</p> : null}
      </form>
    </section>
  );
}
