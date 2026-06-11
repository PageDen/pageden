import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, CheckCircle2, FolderPlus, Sparkles, UploadCloud } from "lucide-react";
import { api, crudErrorMessage } from "../../lib/api";
import { meQuery } from "../../lib/queries";
import { workspaceBaseDomain } from "../../lib/workspace-url";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { pageTitle, usePageTitle } from "../../lib/use-page-title";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

type Workspace = {
  id: string;
  name: string;
  slug?: string | null;
  subdomain?: string | null;
  role: "member" | "admin";
};

function subdomainFromName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function OnboardingPage() {
  usePageTitle(pageTitle("Setup"));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
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

  const workspaces = me.data?.workspaces ?? [];
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const createWorkspace = useMutation({
    mutationFn: () => api.createWorkspace(name.trim(), subdomain.trim()),
    onSuccess: async ({ workspace }) => {
      setError(null);
      setSelectedWorkspaceId(workspace.id);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  function submitWorkspace(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (availability.data && !availability.data.available) {
      setError(availability.data.reason ?? "Choose another workspace URL.");
      return;
    }
    createWorkspace.mutate();
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 dark:bg-slate-950 dark:text-slate-100 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-600 text-lg font-semibold text-white shadow-sm">
              P
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">Pageden setup</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
                Bring your vault. Connect your agent.
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                Start from an existing Obsidian vault, or create an empty workspace and add Codex, Claude, Hermes, or OpenClaw when you are ready.
              </p>
            </div>
          </div>
          {selectedWorkspace ? (
            <Button type="button" variant="secondary" onClick={() => void navigate({ to: "/w/$workspaceId", params: { workspaceId: selectedWorkspace.id } })}>
              Skip for now
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-5 flex items-center gap-3">
              <StepBadge value="1" done={Boolean(selectedWorkspace)} />
              <div>
                <h2 className="text-lg font-semibold text-slate-950 dark:text-slate-50">Create or choose workspace</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">This becomes the home for your imported notes and agent keys.</p>
              </div>
            </div>

            {workspaces.length ? (
              <div className="mb-5 space-y-2">
                {workspaces.map((workspace) => (
                  <WorkspaceChoice
                    key={workspace.id}
                    workspace={workspace}
                    selected={workspace.id === selectedWorkspace?.id}
                    onSelect={() => setSelectedWorkspaceId(workspace.id)}
                  />
                ))}
              </div>
            ) : null}

            <form onSubmit={submitWorkspace} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="mb-4 flex items-center gap-2">
                <FolderPlus className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {workspaces.length ? "Create another workspace" : "Create your first workspace"}
                </h3>
              </div>
              <div className="space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Company or workspace name</span>
                  <Input
                    value={name}
                    onChange={(event) => {
                      const next = event.target.value;
                      setName(next);
                      if (!subdomainEdited) setSubdomain(subdomainFromName(next));
                    }}
                    placeholder="Acme Knowledge"
                    required={!selectedWorkspace}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Workspace URL</span>
                  <div className="flex items-center rounded-md border border-slate-300 bg-white transition focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-100 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-orange-400 dark:focus-within:ring-orange-500/20">
                    <Input
                      value={subdomain}
                      onChange={(event) => {
                        setSubdomainEdited(true);
                        setSubdomain(event.target.value.toLowerCase());
                      }}
                      className="border-0 focus:border-transparent focus:ring-0"
                      placeholder="acme"
                      required={!selectedWorkspace}
                    />
                    <span className="shrink-0 pr-3 text-sm text-slate-500 dark:text-slate-400">.{workspaceBaseDomain}</span>
                  </div>
                  {availability.isFetching ? (
                    <p className="text-xs text-slate-400 dark:text-slate-500">Checking availability...</p>
                  ) : availability.data ? (
                    <p className={`text-xs ${availability.data.available ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}`}>
                      {availability.data.available ? "Available" : availability.data.reason}
                    </p>
                  ) : null}
                </label>
                {error ? <p className="text-sm text-red-600 dark:text-red-300">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={createWorkspace.isPending || !name.trim() || !subdomain.trim()}>
                  {createWorkspace.isPending ? "Creating..." : "Create workspace"}
                </Button>
              </div>
            </form>
          </section>

          <section className="space-y-4">
            <OnboardingAction
              step="2"
              icon={<UploadCloud className="h-5 w-5" aria-hidden="true" />}
              title="Import your Obsidian vault"
              description="Pick your vault folder, preview Markdown files, check duplicates, upload attachments, and download an import report."
              disabled={!selectedWorkspace}
              href={selectedWorkspace ? `/w/${encodeURIComponent(selectedWorkspace.id)}/import` : undefined}
              buttonLabel="Import vault"
            />
            <OnboardingAction
              step="3"
              icon={<Bot className="h-5 w-5" aria-hidden="true" />}
              title="Connect an AI agent"
              description="Choose Codex, Claude, Hermes, OpenClaw, or another MCP client. Pageden creates a scoped key and ready-to-use config."
              disabled={!selectedWorkspace}
              href={selectedWorkspace ? `/w/${encodeURIComponent(selectedWorkspace.id)}/agents` : undefined}
              buttonLabel="Connect agent"
            />
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">After setup</p>
                  <h3 className="mt-1 text-lg font-semibold text-slate-950 dark:text-slate-50">Make the workspace agent-ready</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    Open a document to see AI readiness checks for missing titles, thin notes, broken wikilinks, unresolved embeds, and stale content.
                  </p>
                  {selectedWorkspace ? (
                    <Link
                      to="/w/$workspaceId"
                      params={{ workspaceId: selectedWorkspace.id }}
                      className="mt-4 inline-flex h-10 items-center justify-center rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-orange-400/60 dark:hover:bg-orange-500/10 dark:hover:text-orange-200"
                    >
                      Go to workspace
                      <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <p className="mt-4 text-sm font-medium text-slate-400 dark:text-slate-500">Create or choose a workspace first.</p>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function StepBadge({ value, done }: { value: string; done: boolean }) {
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-orange-600 text-white" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"}`}>
      {done ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : value}
    </span>
  );
}

function WorkspaceChoice({ workspace, selected, onSelect }: { workspace: Workspace; selected: boolean; onSelect: () => void }) {
  const initial = workspace.name.trim().charAt(0).toUpperCase() || "P";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
        selected
          ? "border-orange-300 bg-orange-50 ring-2 ring-orange-100 dark:border-orange-400/60 dark:bg-orange-500/10 dark:ring-orange-500/20"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-slate-700 dark:hover:bg-slate-800/50"
      }`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${selected ? "bg-orange-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-slate-950 dark:text-slate-50">{workspace.name}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
          {workspace.subdomain ? `${workspace.subdomain}.${workspaceBaseDomain}` : workspace.slug}
        </span>
      </span>
      {selected ? <CheckCircle2 className="h-5 w-5 shrink-0 text-orange-600 dark:text-orange-300" aria-hidden="true" /> : null}
    </button>
  );
}

function OnboardingAction({
  step,
  icon,
  title,
  description,
  disabled,
  href,
  buttonLabel,
}: {
  step: string;
  icon: ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  href?: string;
  buttonLabel: string;
}) {
  return (
    <div className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-slate-900 ${disabled ? "border-slate-200 opacity-70 dark:border-slate-800" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-start gap-3">
        <StepBadge value={step} done={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-orange-700 dark:text-orange-300">
            {icon}
            <h3 className="text-lg font-semibold text-slate-950 dark:text-slate-50">{title}</h3>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
          {href && !disabled ? (
            <a
              href={href}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-orange-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-orange-700"
            >
              {buttonLabel}
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </a>
          ) : (
            <p className="mt-4 text-sm font-medium text-slate-400 dark:text-slate-500">Create or choose a workspace first.</p>
          )}
        </div>
      </div>
    </div>
  );
}
