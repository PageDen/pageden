import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { PasswordInput } from "../../components/ui/password-input";

export function AccountPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const authConfig = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60 * 1000, retry: false });

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setDone(true);
      setError(null);
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (e) => {
      setDone(false);
      setError(crudErrorMessage(e));
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError("New password must be at least 8 characters.");
    if (next !== confirm) return setError("New password and confirmation do not match.");
    change.mutate();
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-xl font-semibold text-slate-800">Account</h1>
      <p className="mb-6 text-sm text-slate-500">Change your password.</p>
      <form onSubmit={submit} className="max-w-md space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm text-slate-600">Current password</span>
          <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-slate-600">New password</span>
          <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-slate-600">Confirm new password</span>
          <PasswordInput autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {done ? <p className="text-sm text-green-600">Password changed.</p> : null}
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? "Saving…" : "Change password"}
        </Button>
      </form>

      {authConfig.data?.cloudHosted ? <SecurityActivitySection /> : null}
    </div>
  );
}

type AccountEvent = Awaited<ReturnType<typeof api.accountActivity>>["events"][number];

function SecurityActivitySection() {
  const [events, setEvents] = useState<AccountEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.accountActivity({ before: cursor, limit: 50 });
      setEvents((prev) => (cursor ? [...prev, ...res.events] : res.events));
      setNext(res.next);
    } catch (e) {
      setError(crudErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-10 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Security activity</h2>
        <p className="text-sm text-slate-500">Recent account events tied to you — sign-ins, token use, and changes across your workspaces.</p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-medium text-slate-900">{e.action}</td>
                <td className="px-3 py-2 text-slate-600">{e.targetType}{e.targetId ? `: ${e.targetId}` : ""}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-400">{e.ipAddress ?? "—"}</td>
              </tr>
            ))}
            {events.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">No account activity yet.</td>
              </tr>
            ) : null}
            {loading && events.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">Loading…</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {next ? (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void load(next)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
