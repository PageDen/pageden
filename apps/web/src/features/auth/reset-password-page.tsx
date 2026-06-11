import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { PasswordInput } from "../../components/ui/password-input";

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.resetPassword(token, password),
    onSuccess: () => setError(null),
    onError: (e) => setError(crudErrorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        {!token ? (
          <p className="text-sm text-red-600">This reset link is missing its token. Request a new one.</p>
        ) : mutation.isSuccess ? (
          <>
            <p className="text-sm text-green-700">Your password has been reset.</p>
            <Button type="button" className="w-full" onClick={() => void navigate({ to: "/login" })}>
              Sign in
            </Button>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">New password</span>
              <PasswordInput aria-label="New password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Confirm new password</span>
              <PasswordInput aria-label="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending ? "Resetting…" : "Reset password"}
            </Button>
          </>
        )}
        <p className="text-sm text-slate-500">
          <Link to="/login" className="text-slate-700 underline">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
