import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, crudErrorMessage, type PermissionInput } from "../../lib/api";
import { groupsQuery, usersQuery } from "../../lib/queries";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";

type Kind = "document" | "folder";

export function PermissionsDialog({
  kind,
  id,
  name,
  workspaceId,
  onClose,
}: {
  kind: Kind;
  id: string;
  name: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["permissions", kind, id],
    queryFn: () => (kind === "document" ? api.documentPermissions(id) : api.folderPermissions(id)),
    // Always load fresh so a manager never edits/PUTs a stale cached grant set.
    refetchOnMount: "always",
    staleTime: 0,
  });
  const users = useQuery({ ...usersQuery(workspaceId), retry: false });
  const groups = useQuery({ ...groupsQuery(workspaceId), retry: false });

  const [rows, setRows] = useState<PermissionInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialise the editable list from the server once loaded.
  const editable: PermissionInput[] =
    rows ?? (current.data?.permissions.map((p) => ({ subjectType: p.subjectType, subjectId: p.subjectId, role: p.role })) ?? []);

  const userName = (uid: string) => users.data?.users.find((u) => u.id === uid)?.email ?? uid;
  const groupName = (gid: string) => groups.data?.groups.find((g) => g.id === gid)?.name ?? gid;
  const subjectLabel = (r: PermissionInput) => (r.subjectType === "user" ? userName(r.subjectId) : `group: ${groupName(r.subjectId)}`);

  const save = useMutation({
    mutationFn: () =>
      kind === "document"
        ? api.setDocumentPermissions(id, editable, current.data?.version)
        : api.setFolderPermissions(id, editable, current.data?.version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["permissions", kind, id] });
      // Permission changes affect tree visibility + document access.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "tree" || q.queryKey[0] === "document" });
      onClose();
    },
    onError: (e) => {
      setError(crudErrorMessage(e));
      void current.refetch();
    },
  });

  function update(next: PermissionInput[]) {
    setRows(next);
  }

  return (
    <Dialog
      title={
        <span className="block min-w-0">
          <span className="block">Permissions</span>
          <span className="block truncate text-sm font-normal text-slate-500" title={name}>
            {kind === "document" ? "Document" : "Folder"}: {name}
          </span>
        </span>
      }
      onClose={onClose}
      size="lg"
    >
      {current.isFetching && rows === null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : current.isError ? (
        <p className="text-sm text-slate-500">{crudErrorMessage(current.error)}</p>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {editable.length === 0 ? <li className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-400">No explicit grants.</li> : null}
            {editable.map((r, i) => (
              <li key={`${r.subjectType}:${r.subjectId}`} className="grid gap-2 rounded-md border border-slate-200 p-2 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center">
                <span className="min-w-0 truncate">{subjectLabel(r)}</span>
                <select
                  aria-label="Role"
                  className="rounded-md border border-slate-300 px-2 py-2 text-sm"
                  value={r.role}
                  onChange={(e) => {
                    const next = [...editable];
                    next[i] = { ...r, role: e.target.value as PermissionInput["role"] };
                    update(next);
                  }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="manager">Manager</option>
                </select>
                <Button variant="ghost" className="justify-self-start sm:justify-self-end" onClick={() => update(editable.filter((_, j) => j !== i))}>Remove</Button>
              </li>
            ))}
          </ul>

          <AddGrant
            users={users.data?.users ?? []}
            groups={groups.data?.groups ?? []}
            existing={editable}
            onAdd={(row) => update([...editable, row])}
          />

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || current.isFetching}>{save.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function AddGrant({
  users,
  groups,
  existing,
  onAdd,
}: {
  users: { id: string; email: string; name: string }[];
  groups: { id: string; name: string; slug: string }[];
  existing: PermissionInput[];
  onAdd: (row: PermissionInput) => void;
}) {
  const [subjectType, setSubjectType] = useState<"user" | "group">("user");
  const [subjectId, setSubjectId] = useState("");
  const [role, setRole] = useState<PermissionInput["role"]>("viewer");
  const options = subjectType === "user" ? users.map((u) => ({ id: u.id, label: u.email })) : groups.map((g) => ({ id: g.id, label: g.name }));
  const taken = (sid: string) => existing.some((r) => r.subjectType === subjectType && r.subjectId === sid);

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-[8rem_minmax(12rem,1fr)]">
        <select aria-label="Subject type" className="rounded-md border border-slate-300 px-2 py-2" value={subjectType} onChange={(e) => { setSubjectType(e.target.value as "user" | "group"); setSubjectId(""); }}>
          <option value="user">User</option>
          <option value="group">Group</option>
        </select>
        <select aria-label="Subject" className="min-w-0 rounded-md border border-slate-300 px-2 py-2" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">Select…</option>
          {options.filter((o) => !taken(o.id)).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <select aria-label="Role" className="w-32 rounded-md border border-slate-300 px-2 py-2" value={role} onChange={(e) => setRole(e.target.value as PermissionInput["role"])}>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="manager">Manager</option>
        </select>
        <Button
          variant="ghost"
          disabled={!subjectId}
          onClick={() => {
            if (!subjectId) return;
            onAdd({ subjectType, subjectId, role });
            setSubjectId("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
