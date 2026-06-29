import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { PasswordInput } from "../../components/ui/password-input";
import { Dialog } from "../../components/ui/dialog";

export function AccountPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);

  const deletionPreview = useQuery({
    queryKey: ["account", "deletion-preview"],
    queryFn: () => api.accountDeletionPreview(),
  });
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

  const sendDeletionCode = useMutation({
    mutationFn: () => api.sendAccountDeletionCode(),
    onSuccess: (result) => {
      setCodeExpiresAt(result.expiresAt);
      setDeleteConfirm("");
      setDeleteCode("");
      setDeleteError(null);
      setDeleteDialogOpen(true);
    },
    onError: (e) => setDeleteError(crudErrorMessage(e)),
  });

  const deleteAccount = useMutation({
    mutationFn: () => api.deleteAccount(deleteConfirm, deleteCode),
    onSuccess: () => {
      window.location.assign("/login");
    },
    onError: (e) => setDeleteError(crudErrorMessage(e)),
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
      <section className="max-w-md">
        <h1 className="mb-1 text-xl font-semibold text-slate-800">Account</h1>
        <p className="mb-6 text-sm text-slate-500">Change your password.</p>
        <form onSubmit={submit} className="space-y-3">
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
      </section>

      {authConfig.data?.cloudHosted ? <SecurityActivitySection /> : null}

      <section className="mt-10 border-t border-slate-200 pt-8">
        <h2 className="text-base font-semibold text-red-700">Delete account</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
          Permanently remove your login, tokens, connected accounts, and any workspace where you are the only member.
          Shared workspaces stay available to the remaining members.
        </p>
        {deletionPreview.data ? (
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <p className="font-medium text-red-800">Deleted with your account</p>
              <p className="mt-1 text-red-700">{deletionPreview.data.soleWorkspaces.length} solo workspace(s)</p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="font-medium text-slate-800">Preserved for the team</p>
              <p className="mt-1 text-slate-600">{deletionPreview.data.sharedWorkspaces.length} shared workspace(s)</p>
            </div>
          </div>
        ) : null}
        {deleteError && !deleteDialogOpen ? <p className="mt-3 text-sm text-red-600">{deleteError}</p> : null}
        <Button
          type="button"
          variant="danger"
          className="mt-5"
          disabled={sendDeletionCode.isPending || deletionPreview.isLoading}
          onClick={() => sendDeletionCode.mutate()}
        >
          {sendDeletionCode.isPending ? "Sending code…" : "Delete my account"}
        </Button>
      </section>

      {deleteDialogOpen ? (
        <Dialog title="Delete your account?" onClose={() => setDeleteDialogOpen(false)} size="lg">
          <div className="space-y-4 text-sm text-slate-600">
            <p>
              We sent a 6-digit code to <strong>{deletionPreview.data?.userEmail ?? "your email"}</strong>.
              Enter it below and type <strong>DELETE</strong> to permanently delete this account.
            </p>
            {deletionPreview.data?.soleWorkspaces.length ? (
              <div>
                <p className="font-medium text-slate-900">Solo workspaces to delete</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {deletionPreview.data.soleWorkspaces.map((workspace) => (
                    <li key={workspace.id}>{workspace.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {deletionPreview.data?.sharedWorkspaces.length ? (
              <div>
                <p className="font-medium text-slate-900">Shared workspaces preserved</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {deletionPreview.data.sharedWorkspaces.map((workspace) => (
                    <li key={workspace.id}>
                      {workspace.name} ({workspace.otherMemberCount} other member{workspace.otherMemberCount === 1 ? "" : "s"})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <label className="block">
              <span className="mb-1 block font-medium text-slate-700">Email code</span>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={deleteCode}
                onChange={(e) => setDeleteCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-slate-700">Type DELETE</span>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
              />
            </label>
            {codeExpiresAt ? <p className="text-xs text-slate-500">Code expires at {new Date(codeExpiresAt).toLocaleTimeString()}.</p> : null}
            {deleteError ? <p className="text-sm text-red-600">{deleteError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deleteAccount.isPending}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={deleteAccount.isPending || deleteCode.length !== 6 || deleteConfirm !== "DELETE"}
                onClick={() => deleteAccount.mutate()}
              >
                {deleteAccount.isPending ? "Deleting…" : "Delete account"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
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
