import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, Link2, Trash2 } from "lucide-react";
import { api, crudErrorMessage } from "../../lib/api";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";
import { track } from "../../lib/analytics-bus";

interface Share {
  id: string;
  slug: string;
  hasPassword: boolean;
  allowIndexing: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  createdAt: string;
}

function shareUrl(slug: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/s/${slug}`;
}

function formatExpiry(value: string | null): string {
  if (!value) return "Never expires";
  const date = new Date(value);
  return `Expires ${date.toLocaleString()}`;
}

export function ShareDialog({
  documentId,
  workspaceId,
  documentTitle,
  onClose,
}: {
  documentId: string;
  workspaceId: string;
  documentTitle: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const sharesKey = ["document-shares", documentId];
  const shares = useQuery({
    queryKey: sharesKey,
    queryFn: () => api.listShares(workspaceId, { documentId, includeRevoked: false }),
    refetchOnMount: "always",
    staleTime: 0,
  });

  const [password, setPassword] = useState("");
  const [ttlDays, setTtlDays] = useState<string>("");
  const [allowIndexing, setAllowIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createShare(documentId, {
        password: password.trim() ? password : null,
        allowIndexing,
        ttlDays: ttlDays.trim() ? Number(ttlDays) : undefined,
      }),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setTtlDays("");
      setAllowIndexing(false);
      void queryClient.invalidateQueries({ queryKey: sharesKey });
      track("share_link_created", {
        has_password: Boolean(result.share?.hasPassword),
        allow_indexing: Boolean(result.share?.allowIndexing),
        has_expiry: Boolean(result.share?.expiresAt),
      });
    },
    onError: (err) => setError(crudErrorMessage(err)),
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) => api.revokeShare(shareId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharesKey });
      track("share_link_revoked");
    },
    onError: (err) => setError(crudErrorMessage(err)),
  });

  async function copy(slug: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareUrl(slug));
      setCopiedSlug(slug);
      window.setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 1500);
    } catch {
      // Clipboard may be blocked (insecure origin / permissions). Fall through silently —
      // the URL is still visible and selectable in the input next to the button.
    }
  }

  const active = (shares.data?.shares ?? []).filter((s: Share) => s.active);

  return (
    <Dialog
      title={
        <span className="block min-w-0">
          <span className="block">Public share</span>
          <span className="block truncate text-sm font-normal text-slate-500" title={documentTitle}>
            {documentTitle}
          </span>
        </span>
      }
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        {shares.isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : shares.isError ? (
          <p className="text-sm text-slate-500">{crudErrorMessage(shares.error)}</p>
        ) : active.length === 0 ? (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-400">No active share links.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((share: Share) => (
              <li key={share.id} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Link2 size={14} className="shrink-0 text-slate-400" />
                  <Input value={shareUrl(share.slug)} readOnly className="h-9 flex-1" onFocus={(e) => e.currentTarget.select()} />
                  <Button
                    variant="ghost"
                    className="h-9 shrink-0 gap-1.5 px-2.5"
                    onClick={() => void copy(share.slug)}
                    title="Copy link"
                  >
                    {copiedSlug === share.slug ? <Check size={14} /> : <Clipboard size={14} />}
                    {copiedSlug === share.slug ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-9 shrink-0 gap-1.5 px-2.5 text-red-600 hover:bg-red-50"
                    onClick={() => revoke.mutate(share.id)}
                    disabled={revoke.isPending}
                    title="Revoke link"
                  >
                    <Trash2 size={14} />
                    Revoke
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                  <span>{formatExpiry(share.expiresAt)}</span>
                  {share.hasPassword ? <span className="text-amber-700">· Password required</span> : null}
                  {share.allowIndexing ? <span>· Indexable</span> : <span>· No-index</span>}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-700">Create a new link</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Password (optional)</span>
              <PasswordInput
                aria-label="Share password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Expires after (days, optional)</span>
              <Input
                aria-label="Expires after days"
                type="number"
                min={1}
                max={365}
                value={ttlDays}
                onChange={(e) => setTtlDays(e.target.value)}
                placeholder="Never"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={allowIndexing}
              onChange={(e) => setAllowIndexing(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Allow search engines to index this link
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create link"}
            </Button>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
