import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { PasswordInput } from "../../components/ui/password-input";

export function AccountPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
    <div className="mx-auto max-w-md p-8">
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
    </div>
  );
}
