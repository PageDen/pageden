import { useCallback, useRef, useState } from "react";

/** Canonical form the server/plugin use: LF newlines + exactly one trailing newline. */
export function canonicalize(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n*$/, "") + "\n";
}

/**
 * Editor draft with explicit baseVersion ownership (Codex review): the draft owns the
 * baseVersion captured when the buffer opened. Background refetches update the displayed
 * document elsewhere but must NEVER mutate this base or the dirty buffer. Saves send this
 * captured base; only after a successful write do we advance it via `commit`.
 */
export function useDocumentDraft(initial: { content: string; version: string }) {
  const [content, setContent] = useState(initial.content);
  const baseVersionRef = useRef(initial.version);
  const initialContentRef = useRef(initial.content);

  // Compare canonical forms so CRLF/trailing-newline-only differences don't read as dirty.
  const dirty = canonicalize(content) !== canonicalize(initialContentRef.current);
  const baseVersion = baseVersionRef.current;

  /** Replace the buffer with server content (e.g. user chose "reload server version"). */
  const reset = useCallback((next: { content: string; version: string }) => {
    baseVersionRef.current = next.version;
    initialContentRef.current = next.content;
    setContent(next.content);
  }, []);

  /**
   * After a successful save: advance the base to the saved version/content WITHOUT touching
   * the live buffer. If the user kept typing while the save was in flight, the buffer differs
   * from savedContent and `dirty` stays true (they can save again against the new base) — we
   * never overwrite newer edits.
   */
  const commit = useCallback((nextVersion: string, savedContent: string) => {
    baseVersionRef.current = nextVersion;
    initialContentRef.current = savedContent;
  }, []);

  // Live reads (from refs) so a save initiated at click time uses the current base, not a
  // value captured in a stale render closure.
  const getBaseVersion = useCallback(() => baseVersionRef.current, []);

  return {
    content,
    setContent,
    dirty,
    baseVersion,
    getBaseVersion,
    reset,
    commit,
    canonical: () => canonicalize(content),
  };
}
