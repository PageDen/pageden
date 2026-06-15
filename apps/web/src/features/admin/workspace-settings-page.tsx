import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, crudErrorMessage } from "../../lib/api";
import { treeQuery } from "../../lib/queries";
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
      <AgentEditScopeSection workspaceId={workspaceId} />
    </div>
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
