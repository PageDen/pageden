import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, crudErrorMessage } from "../../lib/api";
import { groupsQuery, usersQuery } from "../../lib/queries";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { slugify } from "../../lib/slug";

export function AdminGroups() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const queryClient = useQueryClient();
  const groups = useQuery(groupsQuery(workspaceId));
  const users = useQuery(usersQuery(workspaceId));
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberSel, setMemberSel] = useState<Record<string, string>>({});

  const createGroup = useMutation({
    mutationFn: () => api.createGroup({ workspaceId, name: name.trim(), slug: slugify(name) }),
    onSuccess: () => {
      setName("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: groupsQuery(workspaceId).queryKey });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });
  const addMember = useMutation({
    mutationFn: (vars: { groupId: string; userId: string }) => api.addGroupMember(vars.groupId, vars.userId),
    onSuccess: () => { setError(null); setNotice("Member added."); },
    onError: (e) => { setNotice(null); setError(crudErrorMessage(e)); },
  });
  const removeMember = useMutation({
    mutationFn: (vars: { groupId: string; userId: string }) => api.removeGroupMember(vars.groupId, vars.userId),
    onSuccess: () => { setError(null); setNotice("Member removed."); },
    onError: (e) => { setNotice(null); setError(crudErrorMessage(e)); },
  });

  const userOptions = users.data?.users ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold">Groups</h1>
      <form
        className="mb-5 flex items-end gap-2 rounded-md border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          createGroup.mutate();
        }}
      >
        <label className="flex-1 space-y-1">
          <span className="text-sm font-medium">New group name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <Button type="submit" disabled={createGroup.isPending || !name.trim()}>Create group</Button>
      </form>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="mb-3 text-sm text-emerald-700">{notice}</p> : null}
      <p className="mb-3 text-xs text-slate-400">Add or remove a member by selecting them below. Current membership is not listed yet.</p>

      {groups.isLoading ? (
        <p className="text-slate-400">Loading…</p>
      ) : groups.isError ? (
        <p className="text-slate-500">{crudErrorMessage(groups.error)}</p>
      ) : groups.data!.groups.length === 0 ? (
        <p className="text-slate-400">No groups yet.</p>
      ) : (
        <ul className="space-y-2">
          {groups.data!.groups.map((g) => {
            const sel = memberSel[g.id] ?? "";
            return (
              <li key={g.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
                <div className="mb-2 font-medium">{g.name} <span className="text-xs text-slate-400">({g.slug})</span></div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Member"
                    className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    value={sel}
                    onChange={(e) => setMemberSel({ ...memberSel, [g.id]: e.target.value })}
                  >
                    <option value="">Select a member…</option>
                    {userOptions.map((u) => (
                      <option key={u.id} value={u.id}>{u.name} — {u.email}</option>
                    ))}
                  </select>
                  <Button variant="ghost" disabled={!sel || addMember.isPending} onClick={() => sel && addMember.mutate({ groupId: g.id, userId: sel })}>Add</Button>
                  <Button variant="ghost" disabled={!sel || removeMember.isPending} onClick={() => sel && removeMember.mutate({ groupId: g.id, userId: sel })}>Remove</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
