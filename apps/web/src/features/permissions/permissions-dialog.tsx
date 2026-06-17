import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, Link2, Trash2 } from "lucide-react";
import { api, crudErrorMessage, type PermissionInput } from "../../lib/api";
import { groupsQuery, treeQuery, usersQuery } from "../../lib/queries";
import { Dialog } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PasswordInput } from "../../components/ui/password-input";
import { PeopleCombobox, type ComboboxRole } from "../../components/ui/people-combobox";
import { track } from "../../lib/analytics-bus";

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
    // Always load fresh so a manager never edits a stale grant set.
    refetchOnMount: "always",
    staleTime: 0,
  });
  const users = useQuery({ ...usersQuery(workspaceId), retry: false });
  const groups = useQuery({ ...groupsQuery(workspaceId), retry: false });
  const tree = useQuery({ ...treeQuery(workspaceId), staleTime: 30_000 });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerRole, setPickerRole] = useState<ComboboxRole>("viewer");

  const explicit = current.data?.permissions ?? [];
  const inherited = current.data?.inheritedPermissions ?? [];

  const subjectDetails = new Map([
    ...explicit.map((p) => [`${p.subjectType}:${p.subjectId}`, p.subject] as const),
    ...inherited.map((p) => [`${p.subjectType}:${p.subjectId}`, p.subject] as const),
  ]);
  const userName = (uid: string) => users.data?.users.find((u) => u.id === uid)?.email ?? uid;
  const groupName = (gid: string) => groups.data?.groups.find((g) => g.id === gid)?.name ?? gid;
  const subjectLabel = (subjectType: "user" | "group", subjectId: string) => {
    const subject = subjectDetails.get(`${subjectType}:${subjectId}`);
    if (subject?.type === "user") return subject.name ? `${subject.name} (${subject.email})` : subject.email;
    if (subject?.type === "group") return `group: ${subject.name}`;
    return subjectType === "user" ? userName(subjectId) : `group: ${groupName(subjectId)}`;
  };

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["permissions", kind, id] });
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "tree" || q.queryKey[0] === "document" });
  }

  // Optimistic mutations — each row write fires its own targeted endpoint and
  // refetches on success. The Save button is gone; "Done" simply closes.
  const addByEmail = useMutation({
    mutationFn: (vars: { email: string; role: PermissionInput["role"] }) =>
      kind === "document"
        ? api.grantDocumentPermission(id, vars)
        : api.grantFolderPermission(id, vars),
    onSuccess: (result) => {
      setError(null);
      setNotice(`Shared with ${result.user.email}.`);
      track("permission_granted", { kind, method: "email" });
      void queryClient.invalidateQueries({ queryKey: usersQuery(workspaceId).queryKey });
      invalidate();
    },
    onError: (e) => {
      setNotice(null);
      setError(crudErrorMessage(e));
    },
  });

  const addBySubject = useMutation({
    mutationFn: (vars: { subjectType: "user" | "group"; subjectId: string; role: PermissionInput["role"] }) =>
      kind === "document" ? api.addDocumentPermission(id, vars) : api.addFolderPermission(id, vars),
    onSuccess: (_data, vars) => {
      setError(null);
      setNotice(null);
      invalidate();
      track("permission_granted", { kind, method: vars.subjectType });
    },
    onError: (e) => setError(crudErrorMessage(e)),
  });

  const updateRole = useMutation({
    mutationFn: (vars: { permissionId: string; role: PermissionInput["role"] }) =>
      kind === "document"
        ? api.updateDocumentPermission(id, vars.permissionId, vars.role)
        : api.updateFolderPermission(id, vars.permissionId, vars.role),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => {
      setError(crudErrorMessage(e));
      void current.refetch();
    },
  });

  const removeRow = useMutation({
    mutationFn: (permissionId: string) =>
      kind === "document"
        ? api.removeDocumentPermission(id, permissionId)
        : api.removeFolderPermission(id, permissionId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => {
      setError(crudErrorMessage(e));
      void current.refetch();
    },
  });

  function addExistingFromCombobox(subjectType: "user" | "group", subjectId: string) {
    if (explicit.some((r) => r.subjectType === subjectType && r.subjectId === subjectId)) return;
    addBySubject.mutate({ subjectType, subjectId, role: pickerRole });
  }
  function inviteFromCombobox(email: string) {
    addByEmail.mutate({ email, role: pickerRole });
  }

  // For a document, find the parent folder so we can render
  // "Inherits access from /Retirement" in the General access slot.
  const documentParentFolder = kind === "document"
    ? (() => {
        const doc = tree.data?.documents.find((d) => d.id === id);
        if (!doc) return null;
        return tree.data?.folders.find((f) => f.id === doc.folderId) ?? null;
      })()
    : null;

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
      {current.isFetching && current.data === undefined ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : current.isError ? (
        <p className="text-sm text-slate-500">{crudErrorMessage(current.error)}</p>
      ) : (
        <div className="space-y-3">
          {kind === "folder" ? (
            <GeneralAccessSection folderId={id} workspaceId={workspaceId} />
          ) : documentParentFolder ? (
            <DocumentInheritsFromSection folderName={documentParentFolder.name} folderPath={documentParentFolder.path} />
          ) : null}

          <PeopleCombobox
            users={users.data?.users ?? []}
            groups={groups.data?.groups ?? []}
            existing={explicit}
            role={pickerRole}
            onRoleChange={setPickerRole}
            onAddExisting={addExistingFromCombobox}
            onInviteEmail={inviteFromCombobox}
            isInviting={addByEmail.isPending || addBySubject.isPending}
            helper={`Type a name to add an existing member, or paste an email to invite a guest of this ${kind}.`}
          />

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium text-slate-700">People with access</h3>
              <p className="mt-1 text-xs text-slate-500">Changes take effect immediately.</p>
            </div>
            <ul className="space-y-2">
              {explicit.length === 0 ? (
                <li className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-400">No explicit grants.</li>
              ) : null}
              {explicit.map((row) => (
                <li
                  key={row.id}
                  className="grid gap-2 rounded-md border border-slate-200 p-2 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{subjectLabel(row.subjectType, row.subjectId)}</span>
                    <EffectiveRoleBadge
                      role={row.role}
                      effectiveRole={row.effectiveRole}
                      effectiveSource={row.effectiveSource}
                    />
                  </span>
                  <select
                    aria-label="Role"
                    className="rounded-md border border-slate-300 px-2 py-2 text-sm"
                    value={row.role}
                    onChange={(e) =>
                      updateRole.mutate({ permissionId: row.id, role: e.target.value as PermissionInput["role"] })
                    }
                    disabled={updateRole.isPending && updateRole.variables?.permissionId === row.id}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="manager">Manager</option>
                  </select>
                  <Button
                    variant="ghost"
                    className="justify-self-start sm:justify-self-end"
                    onClick={() => removeRow.mutate(row.id)}
                    disabled={removeRow.isPending && removeRow.variables === row.id}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          {inherited.length > 0 ? (
            <InheritedSection inherited={inherited} subjectLabel={subjectLabel} />
          ) : null}

          {kind === "document" ? (
            <PublicLinkSection documentId={id} workspaceId={workspaceId} />
          ) : null}

          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function InheritedSection({
  inherited,
  subjectLabel,
}: {
  inherited: NonNullable<Awaited<ReturnType<typeof api.folderPermissions>>["inheritedPermissions"]>;
  subjectLabel: (subjectType: "user" | "group", subjectId: string) => string;
}) {
  const groups = new Map<string, typeof inherited>();
  for (const row of inherited) {
    const key = row.inheritedFrom.folderId;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <div>
        <h3 className="text-sm font-medium text-slate-700">Inherited access</h3>
        <p className="mt-1 text-xs text-slate-500">
          These people see this content because of a grant on an ancestor folder. Change the grant there to revoke.
        </p>
      </div>
      <ul className="space-y-3">
        {[...groups.entries()].map(([folderId, rows]) => {
          const first = rows[0]!;
          return (
            <li key={folderId} className="space-y-1.5">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Inherited from {first.inheritedFrom.folderPath || first.inheritedFrom.folderName}
              </p>
              <ul className="space-y-1.5">
                {rows.map((row) => (
                  <li
                    key={`${row.subjectType}:${row.subjectId}`}
                    className="grid gap-2 rounded-md border border-dashed border-slate-200 bg-slate-50 p-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <span className="min-w-0 truncate text-slate-600">{subjectLabel(row.subjectType, row.subjectId)}</span>
                    <span className="text-xs text-slate-500">{roleLabel(row.role)} · inherited</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function roleLabel(role: "viewer" | "editor" | "manager"): string {
  if (role === "viewer") return "Viewer";
  if (role === "editor") return "Editor";
  return "Manager";
}

// Phase 4a: only render when the explicit role and the resolver-computed
// effective role diverge. The two `_tier` / `admin` / `default_role` cases
// each get a one-line "what overrode it" sentence so the manager isn't left
// guessing why the dropdown change didn't take effect.
function EffectiveRoleBadge({
  role,
  effectiveRole,
  effectiveSource,
}: {
  role: "viewer" | "editor" | "manager";
  effectiveRole: "viewer" | "editor" | "manager";
  effectiveSource: "explicit" | "admin" | "viewer_tier" | "default_role";
}) {
  if (effectiveSource === "explicit" || effectiveRole === role) return null;
  let reason: string;
  if (effectiveSource === "admin") reason = "user is a workspace admin";
  else if (effectiveSource === "viewer_tier") reason = "workspace viewer tier caps role at viewer";
  else reason = "folder default role";
  const elevated = effectiveSource !== "viewer_tier";
  return (
    <span
      className={`mt-1 inline-block text-xs ${elevated ? "text-amber-700" : "text-slate-500"}`}
      title={`Effective role: ${roleLabel(effectiveRole)} (${reason})`}
    >
      Effective: <span className="font-medium">{roleLabel(effectiveRole)}</span> · {reason}
    </span>
  );
}

function GeneralAccessSection({ folderId, workspaceId }: { folderId: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const tree = useQuery({ ...treeQuery(workspaceId), staleTime: 30_000 });
  const folder = tree.data?.folders.find((f) => f.id === folderId);
  const serverValue: DefaultRole = (folder?.defaultRole ?? null) as DefaultRole;
  const [value, setValue] = useState<DefaultRole>(serverValue);
  const [error, setError] = useState<string | null>(null);

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
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">General access</span>
        <span className="text-xs text-slate-500">
          Set the default role for everyone in the workspace. Guests still need an explicit grant below.
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

function DocumentInheritsFromSection({ folderName, folderPath }: { folderName: string; folderPath: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <span className="block font-medium text-slate-700">General access</span>
      <p className="mt-1 text-xs text-slate-500">
        Inherits access from{" "}
        <span className="font-medium text-slate-700">{folderPath || folderName}</span>
        . Adjust the parent folder's General access to change it.
      </p>
    </div>
  );
}

// Phase 3: public-link sharing folded into the same dialog as the per-user
// grants. Documents only — folders don't yet have a public-link concept.
function PublicLinkSection({ documentId, workspaceId }: { documentId: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const sharesKey = ["document-shares", documentId];
  const shares = useQuery({
    queryKey: sharesKey,
    queryFn: () => api.listShares(workspaceId, { documentId, includeRevoked: false }),
    refetchOnMount: "always",
    staleTime: 0,
  });

  const [password, setPassword] = useState("");
  const [ttlDays, setTtlDays] = useState<string>("");
  const [allowIndexing, setAllowIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createShare(documentId, {
        password: password.trim() ? password : null,
        allowIndexing,
        ttlDays: ttlDays.trim() ? Number(ttlDays) : undefined,
      }),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setTtlDays("");
      setAllowIndexing(false);
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: sharesKey });
      track("share_link_created", {
        has_password: Boolean(result.share?.hasPassword),
        allow_indexing: Boolean(result.share?.allowIndexing),
        has_expiry: Boolean(result.share?.expiresAt),
      });
    },
    onError: (err) => setError(crudErrorMessage(err)),
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) => api.revokeShare(shareId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharesKey });
      track("share_link_revoked");
    },
    onError: (err) => setError(crudErrorMessage(err)),
  });

  async function copy(slug: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(shareUrl(slug));
      setCopiedSlug(slug);
      window.setTimeout(() => setCopiedSlug((s) => (s === slug ? null : s)), 1500);
    } catch {
      // Clipboard may be blocked (insecure origin); the URL is still selectable.
    }
  }

  const active = (shares.data?.shares ?? []).filter((s) => s.active);

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <div>
        <h3 className="text-sm font-medium text-slate-700">Public link</h3>
        <p className="mt-1 text-xs text-slate-500">
          Share a read-only view with anyone who has the link. No PageDen account required.
        </p>
      </div>
      {shares.isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : shares.isError ? (
        <p className="text-sm text-slate-500">{crudErrorMessage(shares.error)}</p>
      ) : active.length === 0 && !creating ? (
        <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-500">No active link.</span>
          <Button variant="ghost" onClick={() => setCreating(true)}>
            Create link
          </Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {active.map((share) => (
            <li key={share.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="flex items-center gap-2">
                <Link2 size={14} className="shrink-0 text-slate-400" />
                <Input value={shareUrl(share.slug)} readOnly className="h-9 flex-1" onFocus={(e) => e.currentTarget.select()} />
                <Button
                  variant="ghost"
                  className="h-9 shrink-0 gap-1.5 px-2.5"
                  onClick={() => void copy(share.slug)}
                  title="Copy link"
                >
                  {copiedSlug === share.slug ? <Check size={14} /> : <Clipboard size={14} />}
                  {copiedSlug === share.slug ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 shrink-0 gap-1.5 px-2.5 text-red-600 hover:bg-red-50"
                  onClick={() => revoke.mutate(share.id)}
                  disabled={revoke.isPending}
                  title="Revoke link"
                >
                  <Trash2 size={14} />
                  Revoke
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                <span>{formatExpiry(share.expiresAt)}</span>
                {share.hasPassword ? <span className="text-amber-700">· Password required</span> : null}
                {share.allowIndexing ? <span>· Indexable</span> : <span>· No-index</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating || active.length > 0 ? (
        <details className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3" open={creating}>
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            {active.length === 0 ? "New link options" : "Add another link"}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Password (optional)</span>
              <PasswordInput
                aria-label="Share password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Expires after (days, optional)</span>
              <Input
                aria-label="Expires after days"
                type="number"
                min={1}
                max={365}
                value={ttlDays}
                onChange={(e) => setTtlDays(e.target.value)}
                placeholder="Never"
              />
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={allowIndexing}
              onChange={(e) => setAllowIndexing(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Allow search engines to index this link
          </label>
          {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            {active.length > 0 ? (
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            ) : null}
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create link"}
            </Button>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function shareUrl(slug: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/s/${slug}`;
}

function formatExpiry(value: string | null): string {
  if (!value) return "Never expires";
  const date = new Date(value);
  return `Expires ${date.toLocaleString()}`;
}
