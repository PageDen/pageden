import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { GoogleButton } from "./google-button";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { workspaceBaseDomain } from "../../lib/workspace-url";
import { TurnstileWidget } from "../../components/turnstile";

function subdomainFromName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const debouncedSubdomain = useDebouncedValue(subdomain.trim(), 250);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const authConfig = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig() });
  const captcha = authConfig.data?.captcha ?? null;
  const availability = useQuery({
    queryKey: ["workspace-availability", debouncedSubdomain],
    queryFn: () => api.workspaceAvailability(debouncedSubdomain),
    enabled: debouncedSubdomain.length > 0,
  });

  const mutation = useMutation({
    mutationFn: () => api.register(email, name, password, companyName, subdomain, captchaToken ?? undefined),
    onSuccess: (me) => {
      queryClient.setQueryData(["me"], me);
      void navigate({ to: "/" });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (availability.data && !availability.data.available) return setError(availability.data.reason ?? "Choose another workspace URL.");
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-3.5 rounded-lg border border-slate-200 bg-white p-7 shadow-sm">
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
          <h1 className="text-2xl font-medium text-slate-900 mb-1">Create your workspace</h1>
          <p className="text-sm text-slate-500">Free to start. Invite your team later.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-slate-600">Name</span>
          <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-10" required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-slate-600">Email</span>
          <Input type="email" aria-label="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-slate-600">Password</span>
          <PasswordInput aria-label="Password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Company</span>
          <Input
            aria-label="Company"
            value={companyName}
            onChange={(e) => {
              const nextCompanyName = e.target.value;
              setCompanyName(nextCompanyName);
              if (!subdomainEdited) setSubdomain(subdomainFromName(nextCompanyName));
            }}
            className="h-10"
            required
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Workspace URL</span>
          <div className="flex items-center rounded-md border border-slate-300 bg-white transition focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-100">
            <Input
              aria-label="Workspace URL"
              value={subdomain}
              onChange={(e) => {
                setSubdomainEdited(true);
                setSubdomain(e.target.value.toLowerCase());
              }}
              className="h-10 border-0 focus:border-transparent focus:ring-0"
              required
            />
            <span className="shrink-0 pr-3 text-sm text-slate-500">.{workspaceBaseDomain}</span>
          </div>
          {availability.isFetching ? (
            <p className="text-xs text-slate-400">Checking availability…</p>
          ) : availability.data ? (
            <p className={`text-xs ${availability.data.available ? "text-green-700" : "text-red-600"}`}>
              {availability.data.available ? "Available" : availability.data.reason}
            </p>
          ) : null}
        </label>
        {captcha ? <TurnstileWidget siteKey={captcha.siteKey} onToken={setCaptchaToken} /> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={mutation.isPending || (captcha !== null && captchaToken === null)}
          className="w-full h-10 bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-medium text-sm rounded-md transition-colors"
        >
          {mutation.isPending ? "Creating account…" : "Create account"}
        </button>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200"></div>
          <span className="text-xs text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200"></div>
        </div>
        <GoogleButton />
        <p className="text-center text-sm text-slate-500">
          Already have an account? <Link to="/login" className="text-slate-900 font-medium hover:underline">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
