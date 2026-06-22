import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "../../lib/api";
import { GoogleButton } from "./google-button";
import { AuthBrandHeader } from "./auth-brand-header";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";
import { track } from "../../lib/analytics-bus";

/** A failed OAuth round-trip lands back here as ?error=google. Surface it. */
function oauthErrorMessage(): string | null {
  if (typeof window === "undefined") return null;
  const code = new URLSearchParams(window.location.search).get("error");
  if (!code) return null;
  if (code === "google") return "Couldn't sign in with Google. Try again, or sign in with your email and password.";
  return "Sign-in failed. Please try again.";
}

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      track("user_signed_in", { method: "password" });
      void navigate({ to: "/" });
    },
  });

  const error = mutation.error;
  const mutationMessage =
    error instanceof ApiError
      ? error.status === 429
        ? "Too many attempts. Try again in a minute."
        : error.status === 401
          ? "Invalid email or password."
          : "Could not sign in."
      : error
        ? "Could not sign in."
        : null;
  const message = mutationMessage ?? oauthErrorMessage();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
        <AuthBrandHeader />
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
