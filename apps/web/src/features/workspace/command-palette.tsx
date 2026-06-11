import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { searchQuery } from "../../lib/queries";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { highlightSnippet } from "../../lib/search-highlight";

// Workspace-wide quick search overlay (⌘K / Ctrl-K): content search with highlighted snippets
// and keyboard navigation. Backed by the same /api/search endpoint as the sidebar.
export function CommandPalette({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebouncedValue(query.trim(), 200);

  // Global toggle shortcut.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset + focus when opening.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const search = useQuery({ ...searchQuery(workspaceId, debounced), enabled: open && debounced.length > 0 });
  const results = debounced ? search.data?.results ?? [] : [];

  useEffect(() => {
    setSelected((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  function go(documentId: string) {
    setOpen(false);
    void navigate({ to: "/w/$workspaceId/d/$documentId", params: { workspaceId, documentId } });
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selected];
      if (hit) go(hit.id);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/5"
        role="dialog"
        aria-modal="true"
        aria-label="Search documents"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search document content…"
            aria-label="Search document content"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 sm:block">esc</kbd>
        </div>
        <ul className="overflow-auto py-1" role="listbox">
          {!debounced ? (
            <li className="px-4 py-6 text-center text-sm text-slate-400">Type to search across all documents.</li>
          ) : search.isLoading ? (
            <li className="px-4 py-6 text-center text-sm text-slate-400">Searching…</li>
          ) : search.isError ? (
            <li className="px-4 py-6 text-center text-sm text-red-600">Could not search.</li>
          ) : results.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-slate-400">No results for “{debounced}”.</li>
          ) : (
            results.map((result, i) => (
              <li key={result.id} role="option" aria-selected={i === selected}>
                <button
                  type="button"
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => go(result.id)}
                  className={`block w-full px-4 py-2 text-left ${i === selected ? "bg-slate-100" : "hover:bg-slate-50"}`}
                >
                  <span className="block truncate text-sm text-slate-700">📄 {result.title}</span>
                  <span className="block truncate text-xs text-slate-400">{result.path}</span>
                  {result.snippet ? (
                    <span className="mt-0.5 block text-xs leading-snug text-slate-500 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                      {highlightSnippet(result.snippet)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
