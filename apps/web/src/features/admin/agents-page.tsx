import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Bot, Check, Clipboard, Code2, Download, ExternalLink, KeyRound, PlugZap, ShieldCheck, Sparkles } from "lucide-react";
import { api, crudErrorMessage } from "../../lib/api";
import { tokensQuery, meQuery } from "../../lib/queries";
import { formatDateTime } from "../../lib/format";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const readScopes = ["search", "read"];
const editorScopes = ["search", "read", "create", "update", "append"];
const agentPresets = [
  {
    id: "codex",
    name: "Codex",
    description: "Best for coding agents that need to search, read, and cite product knowledge while working in the repo.",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Use with Claude Desktop or Claude Code through the local MCP bridge.",
  },
  {
    id: "hermes",
    name: "Hermes",
    description: "Use for internal automation agents that need a workspace-bound knowledge source.",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Use with OpenClaw or any MCP-compatible desktop agent.",
  },
] as const;

type AgentPresetId = (typeof agentPresets)[number]["id"];

const agentInstructions: Record<AgentPresetId, string[]> = {
  codex: [
    "Download the Codex config.",
    "Add it to your Codex config file, then restart Codex.",
    "Ask Codex to search or read Pageden to confirm it is connected.",
  ],
  claude: [
    "Download the Claude Desktop config.",
    "Merge it into Claude Desktop's MCP server config, then restart Claude.",
    "Ask Claude to list Pageden documents to confirm it is connected.",
  ],
  hermes: [
    "Copy the Direct HTTP MCP settings.",
    "Paste the endpoint, bearer token, and workspace id into Hermes.",
    "Run a search or read test from Hermes before enabling write actions.",
  ],
  openclaw: [
    "Copy the Direct HTTP MCP settings.",
    "Paste the endpoint, bearer token, and workspace id into OpenClaw.",
    "Run a search or read test before giving the agent editor access.",
  ],
};

export function AgentsPage() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const queryClient = useQueryClient();
  const tokens = useQuery({ ...tokensQuery(), refetchInterval: 8000 });
  const me = useQuery(meQuery);
  const workspace = me.data?.workspaces.find((item) => item.id === workspaceId);
  const [agent, setAgent] = useState<AgentPresetId>("codex");
  const [name, setName] = useState("Codex agent");
  const [preset, setPreset] = useState<"read" | "editor">("read");
  const [raw, setRaw] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const endpoint = `${window.location.origin}/mcp`;
  const connectUrl = `${window.location.origin}/w/${encodeURIComponent(workspaceId)}/agents?connect=mcp`;
  const discoveryUrl = `${window.location.origin}/.well-known/pageden-mcp.json`;
  const oauthDiscoveryUrl = `${window.location.origin}/.well-known/oauth-authorization-server`;
  const selectedScopes = preset === "read" ? readScopes : editorScopes;

  const create = useMutation({
    mutationFn: () => api.createToken(name.trim(), { kind: "agent", workspaceId, scopes: selectedScopes }),
    onSuccess: (token) => {
      setRaw(token.token);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: tokensQuery().queryKey });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokensQuery().queryKey }),
  });

  const testConnection = useMutation({
    mutationFn: async () => {
      if (!raw) throw new Error("Create a key first.");
      return api.testMcpToken(raw, workspaceId);
    },
    onSuccess: (result) => {
      const toolCount = result.result?.tools?.length ?? 0;
      setTestMessage(`Connection works. ${toolCount} Pageden tools are available.`);
    },
    onError: (e) => setTestMessage(crudErrorMessage(e)),
  });

  const snippets = useMemo(() => {
    const token = raw ?? "<paste-token-shown-once>";
    return {
      codex: [
        "[mcp_servers.pageden]",
        'command = "npx"',
        'args = ["@pageden/mcp"]',
        "[mcp_servers.pageden.env]",
        `PAGEDEN_URL = "${window.location.origin}"`,
        `PAGEDEN_TOKEN = "${token}"`,
        `PAGEDEN_WORKSPACE = "${workspaceId}"`,
      ].join("\n"),
      claude: JSON.stringify(
        {
          mcpServers: {
            pageden: {
              command: "npx",
              args: ["@pageden/mcp"],
              env: { PAGEDEN_URL: window.location.origin, PAGEDEN_TOKEN: token, PAGEDEN_WORKSPACE: workspaceId },
            },
          },
        },
        null,
        2,
      ),
      http: [
        `Endpoint: ${endpoint}`,
        `Authorization: Bearer ${token}`,
        `Workspace: ${workspace?.name ?? workspaceId}`,
        "",
        "Tools: pageden_search, pageden_list_documents, pageden_read_document,",
        "       pageden_recent_changes, pageden_create_document,",
        "       pageden_update_document, pageden_append_to_document,",
        "       pageden_answer_from_docs, pageden_find_related_docs,",
        "       pageden_workspace_summary",
      ].join("\n"),
    };
  }, [endpoint, raw, workspace?.name, workspaceId]);

  const selectedAgent = agentPresets.find((item) => item.id === agent) ?? agentPresets[0];
  const selectedSnippet = agent === "claude" ? snippets.claude : agent === "codex" ? snippets.codex : snippets.http;
  const selectedSnippetTitle =
    agent === "claude" ? "Claude Desktop config" : agent === "codex" ? "Codex config" : `${selectedAgent.name} MCP connection`;
  const selectedDownloadName =
    agent === "claude" ? "pageden-claude-desktop.json" : agent === "codex" ? "pageden-codex-config.toml" : `pageden-${agent}-mcp.txt`;
  const setupSteps = [
    { label: "Pick agent", done: Boolean(agent) },
    { label: "Create key", done: Boolean(raw) },
    { label: "Download config", done: Boolean(raw) },
    { label: "Open instructions", done: Boolean(raw) },
    { label: "Test connection", done: testMessage?.startsWith("Connection works") ?? false },
  ];

  const agentTokens = tokens.data?.tokens.filter((token) => token.kind === "agent" && token.workspaceId === workspaceId) ?? [];

  async function copy(label: string, text: string) {
    await navigator.clipboard?.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  }

  function downloadSelectedConfig() {
    downloadText(selectedDownloadName, selectedSnippet);
  }

  return (
    <div className="mx-auto max-w-5xl p-8 text-slate-950 dark:text-slate-100">
      <div className="mb-7 flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
          <Bot size={22} aria-hidden="true" />
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">AI agents</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">Connect Codex, Claude, Hermes, or any MCP agent</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Pick your app, create a workspace-bound key, download the ready-made setup, follow the short instructions, then test the connection.
          </p>
        </div>
      </div>

      <ol className="mb-6 grid gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-5">
        {setupSteps.map((step, index) => (
          <li
            key={step.label}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
              step.done
                ? "bg-orange-50 text-orange-800 dark:bg-orange-500/10 dark:text-orange-200"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.done
                  ? "bg-orange-600 text-white dark:bg-orange-500"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              {step.done ? <Check size={14} aria-hidden="true" /> : index + 1}
            </span>
            <span className="font-medium">{step.label}</span>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-4 flex items-center gap-2">
            <PlugZap className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">1. Choose your agent</h2>
          </div>
          <div className="grid gap-2">
            {agentPresets.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setAgent(item.id);
                  setName(`${item.name} agent`);
                }}
                className={`rounded-lg border p-3 text-left transition ${
                  agent === item.id ? "border-orange-300 bg-orange-50 ring-2 ring-orange-100 dark:border-orange-400/60 dark:bg-orange-500/10 dark:ring-orange-500/20" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
                }`}
              >
                <div className="font-medium text-slate-950 dark:text-slate-50">{item.name}</div>
                <p className="mt-1 text-sm leading-5 text-slate-500 dark:text-slate-400">{item.description}</p>
              </button>
            ))}
          </div>

          <div className="mb-4 mt-6 flex items-center gap-2 border-t border-slate-200 pt-5 dark:border-slate-800">
            <KeyRound className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">2. Create access key</h2>
          </div>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Codex on Chris Mac" required />
            </label>
            <div className="grid gap-2">
              <ScopeOption
                active={preset === "read"}
                title="Read only"
                description="Best for research, summaries, search, and quoting documents."
                scopes={readScopes}
                onClick={() => setPreset("read")}
              />
              <ScopeOption
                active={preset === "editor"}
                title="Editor"
                description="Can create, update, and append documents. Use only for trusted agents."
                scopes={editorScopes}
                onClick={() => setPreset("editor")}
              />
            </div>
            <Button type="submit" className="w-full" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Creating..." : "Create agent key"}
            </Button>
            {error ? <p className="text-sm text-red-600 dark:text-red-300">{error}</p> : null}
          </form>

          {raw ? (
            <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <div className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-200">
                <ShieldCheck size={16} aria-hidden="true" />
                Copy this token now
              </div>
              <code className="mt-2 block break-all rounded-md bg-white px-2 py-2 text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-200">{raw}</code>
              <Button variant="ghost" className="mt-2" onClick={() => void copy("token", raw)}>
                {copied === "token" ? <Check className="mr-2 h-4 w-4" /> : <Clipboard className="mr-2 h-4 w-4" />}
                {copied === "token" ? "Copied" : "Copy token"}
              </Button>
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-4 flex items-center gap-2">
            <Code2 className="h-5 w-5 text-orange-600 dark:text-orange-300" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">3. Download config</h2>
          </div>
          <p className="mb-4 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {raw
              ? `Download this ${selectedAgent.name} setup now. The token cannot be shown again after you leave this page.`
              : "Create a key first. The download will include the one-time token automatically."}
          </p>
          <div className="space-y-4">
            <Snippet
              title={selectedSnippetTitle}
              copied={copied === agent}
              value={selectedSnippet}
              onCopy={() => copy(agent, selectedSnippet)}
              onDownload={downloadSelectedConfig}
            />
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
              <div className="font-medium text-slate-900 dark:text-slate-100">4. Open instructions for {selectedAgent.name}</div>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                {agentInstructions[agent].map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm leading-6 text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-100">
              <div className="flex items-center gap-2 font-medium">
                <ExternalLink size={15} aria-hidden="true" />
                OAuth / one-click clients
              </div>
              <p className="mt-1">
                Clients that support MCP OAuth can discover Pageden automatically. Clients that do not support it yet can use the generated config above.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copy("connect-url", connectUrl)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-800 hover:text-orange-950 dark:text-orange-200 dark:hover:text-orange-100"
                >
                  {copied === "connect-url" ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
                  {copied === "connect-url" ? "Copied connect link" : "Copy connect link"}
                </button>
                <button
                  type="button"
                  onClick={() => void copy("discovery-url", discoveryUrl)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-800 hover:text-orange-950 dark:text-orange-200 dark:hover:text-orange-100"
                >
                  {copied === "discovery-url" ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
                  {copied === "discovery-url" ? "Copied discovery URL" : "Copy discovery URL"}
                </button>
                <button
                  type="button"
                  onClick={() => void copy("oauth-url", oauthDiscoveryUrl)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-800 hover:text-orange-950 dark:text-orange-200 dark:hover:text-orange-100"
                >
                  {copied === "oauth-url" ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
                  {copied === "oauth-url" ? "Copied OAuth URL" : "Copy OAuth URL"}
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
              <div className="font-medium text-slate-900 dark:text-slate-100">5. Test connection</div>
              <p className="mt-1">
                Check that this key can reach <strong>{workspace?.name ?? "this workspace"}</strong>. Revoke it anytime from the active keys list.
              </p>
              <Button className="mt-3" onClick={() => testConnection.mutate()} disabled={!raw || testConnection.isPending}>
                {testConnection.isPending ? "Testing..." : "Test connection"}
              </Button>
              {testMessage ? (
                <p
                  className={`mt-2 text-xs ${
                    testMessage.startsWith("Connection works")
                      ? "text-emerald-700 dark:text-emerald-200"
                      : "text-red-600 dark:text-red-300"
                  }`}
                >
                  {testMessage}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Active agent keys</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Revoke anything you no longer use.</p>
          </div>
          <Sparkles className="h-5 w-5 text-slate-300 dark:text-slate-600" aria-hidden="true" />
        </div>
        {tokens.isLoading ? (
          <p className="p-5 text-sm text-slate-400 dark:text-slate-500">Loading...</p>
        ) : tokens.isError ? (
          <p className="p-5 text-sm text-red-600 dark:text-red-300">{crudErrorMessage(tokens.error)}</p>
        ) : agentTokens.length === 0 ? (
          <p className="p-5 text-sm text-slate-400 dark:text-slate-500">No agent keys for this workspace yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {agentTokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-900 dark:text-slate-100">{token.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 dark:text-slate-500">
                    <span className={`rounded-full px-2 py-0.5 font-medium ${agentStatusClass(Boolean(token.revokedAt), Boolean(token.lastUsedAt))}`}>
                      {token.revokedAt ? "Revoked" : token.lastUsedAt ? "Connected" : "Ready"}
                    </span>
                    <span>{token.scopes.join(", ")}</span>
                    <span aria-hidden="true">·</span>
                    <span>{token.revokedAt ? `Revoked ${formatDateTime(token.revokedAt)}` : token.lastUsedAt ? `Used ${formatDateTime(token.lastUsedAt)}` : "Never used"}</span>
                    {token.lastUsedIp ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{token.lastUsedIp}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                {!token.revokedAt ? (
                  <Button variant="ghost" onClick={() => revoke.mutate(token.id)} disabled={revoke.isPending}>
                    Revoke
                  </Button>
                ) : (
                  <span className="text-xs text-slate-400 dark:text-slate-500">revoked</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScopeOption({
  active,
  title,
  description,
  scopes,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  scopes: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition ${
        active ? "border-orange-300 bg-orange-50 ring-2 ring-orange-100 dark:border-orange-400/60 dark:bg-orange-500/10 dark:ring-orange-500/20" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
      }`}
    >
      <div className="font-medium text-slate-950 dark:text-slate-50">{title}</div>
      <p className="mt-1 text-sm leading-5 text-slate-500 dark:text-slate-400">{description}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {scopes.map((scope) => (
          <span key={scope} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm dark:bg-slate-950 dark:text-slate-300">
            {scope}
          </span>
        ))}
      </div>
    </button>
  );
}

function Snippet({
  title,
  value,
  copied,
  onCopy,
  onDownload,
}: {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={onDownload} className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-700 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200">
            <Download size={13} aria-hidden="true" />
            Download
          </button>
          <button type="button" onClick={onCopy} className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-700 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200">
            {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="max-h-52 overflow-auto bg-slate-950 p-3 text-xs leading-5 text-slate-100">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function agentStatusClass(revoked: boolean, used: boolean) {
  if (revoked) return "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500";
  if (used) return "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200";
  return "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-200";
}
