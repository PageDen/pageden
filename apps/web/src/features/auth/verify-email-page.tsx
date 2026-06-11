import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";

export function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const mutation = useMutation({ mutationFn: () => api.verifyEmail(token) });
  const run = mutation.mutate;
  useEffect(() => {
    if (token) run();
  }, [token, run]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Email verification</h1>
        {!token ? (
          <p className="text-sm text-red-600">This link is missing its token.</p>
        ) : mutation.isPending ? (
          <p className="text-sm text-slate-500">Verifying…</p>
        ) : mutation.isSuccess ? (
          <p className="text-sm text-green-700">Your email is verified. Thanks!</p>
        ) : mutation.isError ? (
          <p className="text-sm text-red-600">This verification link is invalid or has expired.</p>
        ) : null}
        <p className="text-sm text-slate-500">
          <Link to="/" className="text-slate-700 underline">Go to Pageden</Link>
        </p>
      </div>
    </div>
  );
}
