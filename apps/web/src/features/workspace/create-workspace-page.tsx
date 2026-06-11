import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, crudErrorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { meQuery } from "../../lib/queries";
import { workspaceBaseDomain } from "../../lib/workspace-url";

function subdomainFromName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function CreateWorkspacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debouncedSubdomain = useDebouncedValue(subdomain.trim(), 250);
  const availability = useQuery({
    queryKey: ["workspace-availability", debouncedSubdomain],
    queryFn: () => api.workspaceAvailability(debouncedSubdomain),
    enabled: debouncedSubdomain.length > 0,
  });

  const mutation = useMutation({
    mutationFn: () => api.createWorkspace(name, subdomain),
    onSuccess: async ({ workspace }) => {
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      void navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (availability.data && !availability.data.available) return setError(availability.data.reason ?? "Choose another workspace URL.");
    mutation.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-600 text-sm font-semibold text-white shadow-sm">
            P
          </span>
          <span className="text-sm font-semibold text-slate-900">PageDen</span>
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Create company workspace</h1>
          <p className="text-sm text-slate-500">Use the same account across every company you belong to.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Company</span>
          <Input
            aria-label="Company"
            value={name}
            onChange={(e) => {
              const nextName = e.target.value;
              setName(nextName);
              if (!subdomainEdited) setSubdomain(subdomainFromName(nextName));
            }}
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
              className="border-0 focus:border-transparent focus:ring-0"
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
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create workspace"}
        </Button>
        <Link
          to="/"
          className="inline-flex w-full items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Back
        </Link>
      </form>
    </div>
  );
}
