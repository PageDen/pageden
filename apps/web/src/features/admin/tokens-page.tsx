import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { tokensQuery } from "../../lib/queries";
import { formatDateTime } from "../../lib/format";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function TokensPage() {
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery());
  const [name, setName] = useState("");
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createToken(name.trim()),
    onSuccess: (token) => {
      setRaw(token.token);
      setName("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: tokensQuery().queryKey });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokensQuery().queryKey }),
  });
  const personalTokens = tokens.data?.tokens.filter((token) => token.kind !== "agent") ?? [];

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Obsidian tokens</h1>
      <p className="mb-4 text-sm text-slate-500">Personal access tokens for the Obsidian plugin. The full token is shown once.</p>

      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="flex-1 space-y-1">
          <span className="text-sm font-medium">New token name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chris MacBook" required />
        </label>
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </form>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {raw ? (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <p className="font-medium text-emerald-800">Copy your token now — it won't be shown again:</p>
          <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-xs">{raw}</code>
          <Button variant="ghost" className="mt-2" onClick={() => void navigator.clipboard?.writeText(raw)}>Copy</Button>
        </div>
      ) : null}

      {tokens.isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : tokens.isError ? (
        <p className="text-slate-500">{crudErrorMessage(tokens.error)}</p>
      ) : personalTokens.length === 0 ? (
        <p className="text-slate-400">No tokens yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {personalTokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <div>
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-slate-400">
                  {t.revokedAt ? `Revoked ${formatDateTime(t.revokedAt)}` : t.lastUsedAt ? `Last used ${formatDateTime(t.lastUsedAt)}` : "Never used"}
                </div>
              </div>
              {!t.revokedAt ? (
                <Button variant="ghost" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>Revoke</Button>
              ) : (
                <span className="text-xs text-slate-400">revoked</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
