import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ApiError, api, crudErrorMessage } from "../../lib/api";
import { treeQuery, workspacePublicSharingSettingsQuery, workspaceTransferSettingsQuery } from "../../lib/queries";
import { Button } from "../../components/ui/button";

export function WorkspaceSettingsPage() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";

  return (
    <div className="max-w-md space-y-10">
      <div>
        <h2 className="mb-1 text-base font-semibold text-slate-900">Workspace settings</h2>
        <p className="text-sm text-slate-500">Admin-only knobs that affect every member and every agent in this workspace.</p>
      </div>
      <WorkspaceTransferSection workspaceId={workspaceId} />
      <PublicSharingSection workspaceId={workspaceId} />
      <AgentEditScopeSection workspaceId={workspaceId} />
    </div>
  );
}

function PublicSharingSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ ...workspacePublicSharingSettingsQuery(workspaceId), enabled: !!workspaceId });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: (enabled: boolean) => api.setWorkspacePublicSharingSettings(workspaceId, enabled),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: workspacePublicSharingSettingsQuery(workspaceId).queryKey });
      window.setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  if (settings.isLoading || (settings.isError && settings.error instanceof ApiError && settings.error.status === 404)) return null;

  const enabled = settings.data?.enabled ?? true;

  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-slate-900">Public sharing</h2>
      <p className="mb-4 text-sm text-slate-500">
        Allow managers to publish document links and folder manuals that anyone with the link can read.
      </p>
      <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-slate-300"
          checked={enabled}
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-slate-900">Allow public share links</span>
          <span className="block text-sm text-slate-500">When disabled, existing public links stop resolving and new links cannot be created.</span>
        </span>
      </label>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      {saved ? <p className="mt-2 text-sm text-green-700">Saved.</p> : null}
    </section>
  );
}

function WorkspaceTransferSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ ...workspaceTransferSettingsQuery(workspaceId), enabled: !!workspaceId });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = useMutation({
    mutationFn: (enabled: boolean) => api.setWorkspaceTransferSettings(workspaceId, enabled),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: workspaceTransferSettingsQuery(workspaceId).queryKey });
      window.setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  if (settings.isLoading || (settings.isError && settings.error instanceof ApiError && settings.error.status === 404)) return null;

  const enabled = settings.data?.enabled ?? true;

  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-slate-900">Workspace transfer</h2>
      <p className="mb-4 text-sm text-slate-500">
        Allow managers to move documents and folders from this workspace into another workspace where they also have destination access.
      </p>
      <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-slate-300"
          checked={enabled}
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-slate-900">Allow moving content to other workspaces</span>
          <span className="block text-sm text-slate-500">When disabled, documents and folders cannot be transferred out of this workspace.</span>
        </span>
      </label>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      {saved ? <p className="mt-2 text-sm text-green-700">Saved.</p> : null}
    </section>
  );
}

// Pin agent token writes to a single folder subtree. Read paths are
// unaffected — agents can still search and read across the workspace.
function AgentEditScopeSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const scope = useQuery({
    queryKey: ["agent-edit-scope", workspaceId],
    queryFn: () => api.getAgentEditScope(workspaceId),
    enabled: !!workspaceId,
  });
  const tree = useQuery({ ...treeQuery(workspaceId), enabled: !!workspaceId });

  const serverValue = scope.data?.agentEditScopeFolderId ?? null;
  const [selected, setSelected] = useState<string | null>(serverValue);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelected(serverValue);
  }, [serverValue]);

  const save = useMutation({
    mutationFn: () => api.setAgentEditScope(workspaceId, selected),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["agent-edit-scope", workspaceId] });
      window.setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  const folders = (tree.data?.folders ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
  const dirty = selected !== serverValue;

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold text-slate-900">Agent edit scope</h3>
      <p className="mb-4 text-sm text-slate-500">
        Restrict agent token writes to a single folder and its descendants. Reads stay open across
        the whole workspace. Leave unset to let agents write anywhere they have permission.
      </p>
      {scope.isLoading || tree.isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Folder</span>
            <select
              aria-label="Agent edit scope folder"
              className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">Unrestricted (agents may write anywhere)</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.path}
                </option>
              ))}
            </select>
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {saved ? <p className="text-sm text-green-700">Saved.</p> : null}
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save scope"}
          </Button>
        </div>
      )}
    </section>
  );
}
