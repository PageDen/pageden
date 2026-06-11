import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "../../lib/api";
import { GoogleButton } from "./google-button";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      void navigate({ to: "/" });
    },
  });

  const error = mutation.error;
  const message =
    error instanceof ApiError
      ? error.status === 429
        ? "Too many attempts. Try again in a minute."
        : error.status === 401
          ? "Invalid email or password."
          : "Could not sign in."
      : error
        ? "Could not sign in."
        : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
        <div className="mb-5">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-600 text-sm font-semibold text-white shadow-sm">
              P
            </span>
            <span className="text-sm font-semibold text-slate-900">Pageden</span>
          </div>
          <p className="text-xs text-slate-400 leading-snug">One source of truth for people and AI.</p>
        </div>
        <div>
          <h1 className="text-2xl font-medium text-slate-900 mb-1">Sign in</h1>
          <p className="text-sm text-slate-500">Welcome back to your workspace.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-slate-600">Email</span>
          <Input type="email" aria-label="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" required />
        </label>
        <label className="block space-y-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-slate-600">Password</span>
            <Link to="/forgot-password" className="text-xs font-medium text-orange-700 hover:text-orange-800 hover:underline">Forgot?</Link>
          </span>
          <PasswordInput aria-label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" required />
        </label>
        {message ? <p className="text-sm text-red-600 -mt-2">{message}</p> : null}
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full h-10 bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-medium text-sm rounded-md transition-colors"
        >
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200"></div>
          <span className="text-xs text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200"></div>
        </div>
        <GoogleButton />
        <p className="text-center text-sm text-slate-500">
          New here? <Link to="/register" className="text-slate-900 font-medium hover:underline">Create a workspace</Link>
        </p>
      </form>
    </div>
  );
}
