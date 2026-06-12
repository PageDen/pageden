import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { TurnstileWidget } from "../../components/turnstile";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const authConfig = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig() });
  const captcha = authConfig.data?.captcha ?? null;
  const mutation = useMutation({ mutationFn: () => api.forgotPassword(email, captchaToken ?? undefined) });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">Reset your password</h1>
          <p className="text-sm text-slate-500">We'll email you a link to choose a new password.</p>
        </div>
        {mutation.isSuccess ? (
          <p className="text-sm text-green-700">If an account exists for that email, a reset link is on its way.</p>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Email</span>
              <Input type="email" aria-label="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            {captcha ? <TurnstileWidget siteKey={captcha.siteKey} onToken={setCaptchaToken} /> : null}
            {mutation.isError ? <p className="text-sm text-red-600">Could not send the reset link. Try again.</p> : null}
            <Button type="submit" className="w-full" disabled={mutation.isPending || (captcha !== null && captchaToken === null)}>
              {mutation.isPending ? "Sending…" : "Send reset link"}
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
