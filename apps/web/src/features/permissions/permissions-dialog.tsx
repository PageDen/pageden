import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, crudErrorMessage, type PermissionInput } from "../../lib/api";
import { groupsQuery, treeQuery, usersQuery } from "../../lib/queries";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { PeopleCombobox, type ComboboxRole } from "../../components/ui/people-combobox";

type DefaultRole = "viewer" | "editor" | "manager" | null;

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
  const [notice, setNotice] = useState<string | null>(null);
  // Shared role for the combobox — covers both "add an existing user/group"
  // and "invite by email" branches. Reset to viewer after each invite.
  const [pickerRole, setPickerRole] = useState<ComboboxRole>("viewer");

  // Initialise the editable list from the server once loaded.
  const editable: PermissionInput[] =
    rows ?? (current.data?.permissions.map((p) => ({ subjectType: p.subjectType, subjectId: p.subjectId, role: p.role })) ?? []);

  const subjectDetails = new Map(current.data?.permissions.map((p) => [`${p.subjectType}:${p.subjectId}`, p.subject] as const) ?? []);
  const userName = (uid: string) => users.data?.users.find((u) => u.id === uid)?.email ?? uid;
  const groupName = (gid: string) => groups.data?.groups.find((g) => g.id === gid)?.name ?? gid;
  const subjectLabel = (r: PermissionInput) => {
    const subject = subjectDetails.get(`${r.subjectType}:${r.subjectId}`);
    if (subject?.type === "user") return subject.name ? `${subject.name} (${subject.email})` : subject.email;
    if (subject?.type === "group") return `group: ${subject.name}`;
    return r.subjectType === "user" ? userName(r.subjectId) : `group: ${groupName(r.subjectId)}`;
  };

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

  const share = useMutation({
    mutationFn: (vars: { email: string; role: PermissionInput["role"] }) =>
      kind === "document"
        ? api.grantDocumentPermission(id, vars)
        : api.grantFolderPermission(id, vars),
    onSuccess: (result) => {
      setRows(null);
      setError(null);
      setNotice(`Shared with ${result.user.email}.`);
      void queryClient.invalidateQueries({ queryKey: ["permissions", kind, id] });
      void queryClient.invalidateQueries({ queryKey: usersQuery(workspaceId).queryKey });
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "tree" || q.queryKey[0] === "document" });
      void current.refetch();
    },
    onError: (e) => {
      setNotice(null);
      setError(crudErrorMessage(e));
    },
  });

  function update(next: PermissionInput[]) {
    setRows(next);
  }

  function addExistingFromCombobox(subjectType: "user" | "group", subjectId: string) {
    if (editable.some((r) => r.subjectType === subjectType && r.subjectId === subjectId)) return;
    update([...editable, { subjectType, subjectId, role: pickerRole }]);
    setNotice(null);
    setError(null);
  }

  function inviteFromCombobox(email: string) {
    setNotice(null);
    setError(null);
    share.mutate({ email, role: pickerRole });
  }

  return (
    <Dialog
      title={
        <span className="block min-w-0">
          <span className="block">Share</span>
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
          <PeopleCombobox
            users={users.data?.users ?? []}
            groups={groups.data?.groups ?? []}
            existing={editable}
            role={pickerRole}
            onRoleChange={setPickerRole}
            onAddExisting={addExistingFromCombobox}
            onInviteEmail={inviteFromCombobox}
            isInviting={share.isPending}
            helper={`Type a name to add an existing member, or paste an email to invite a guest of this ${kind}.`}
          />

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium text-slate-700">People with access</h3>
              <p className="mt-1 text-xs text-slate-500">Managers can update or remove explicit grants below.</p>
            </div>
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
          </div>

          {kind === "folder" ? (
            <FolderDefaultRoleSection folderId={id} workspaceId={workspaceId} />
          ) : null}

          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
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

// Folder default-role floor — every workspace member sees docs in this folder
// (and descendants without a closer override) as at least this role. null =
// private, the historical "explicit grants only" behavior.
function FolderDefaultRoleSection({ folderId, workspaceId }: { folderId: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const tree = useQuery({ ...treeQuery(workspaceId), staleTime: 30_000 });
  const folder = tree.data?.folders.find((f) => f.id === folderId);
  const serverValue: DefaultRole = (folder?.defaultRole ?? null) as DefaultRole;
  const [value, setValue] = useState<DefaultRole>(serverValue);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the local picker if the tree refetches with a different value.
  useEffect(() => {
    setValue(serverValue);
  }, [serverValue]);

  const save = useMutation({
    mutationFn: () => api.setFolderDefaultRole(folderId, value),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
    },
    onError: (err) => setError(crudErrorMessage(err)),
  });

  const dirty = value !== serverValue;

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Workspace member access</span>
        <span className="text-xs text-slate-500">
          Choose whether all workspace members can access this folder. Guests still need explicit grants.
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <select
          aria-label="Default role"
          className="rounded-md border border-slate-300 px-2 py-2 text-sm"
          value={value ?? ""}
          onChange={(e) => setValue((e.target.value || null) as DefaultRole)}
        >
          <option value="">Private (explicit grants only)</option>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="manager">Manager</option>
        </select>
        <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save default"}
        </Button>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
