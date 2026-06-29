import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ApiError, api, crudErrorMessage } from "../../lib/api";
import { meQuery, treeQuery, workspaceClaimsQuery, workspaceTransferSettingsQuery } from "../../lib/queries";
import { slugify } from "../../lib/slug";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/ui/dialog";
import { DocumentTree, type Doc, type DocClaimSummary, type Folder, type TreeActions } from "./document-tree";
import { PermissionsDialog } from "../permissions/permissions-dialog";
import { track } from "../../lib/analytics-bus";

type DialogState =
  | { kind: "newDoc"; folder: Folder }
  | { kind: "newFolder"; parent: Folder | null }
  | { kind: "renameDoc"; doc: Doc }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "moveDoc"; doc: Doc }
  | { kind: "moveFolder"; folder: Folder }
  | { kind: "transferDoc"; doc: Doc }
  | { kind: "transferFolder"; folder: Folder }
  | { kind: "deleteDoc"; doc: Doc }
  | { kind: "emptyFolder"; folder: Folder }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "permsDoc"; doc: Doc }
  | { kind: "permsFolder"; folder: Folder }
  | null;

export function TreePanel({
  workspaceId,
  folders,
  documents,
  canCreateRoot,
  onNavigate,
  toolbar,
}: {
  workspaceId: string;
  folders: Folder[];
  documents: Doc[];
  canCreateRoot: boolean;
  onNavigate?: () => void;
  toolbar?: (controls: { canCreateRoot: boolean; createRootFolder: () => void }) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const openDocId = params.documentId;
  const openReadablePath = typeof params._splat === "string" && params._splat ? `${params._splat}.md` : null;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Surface active document claims as small pips next to each affected row so
  // multiple agents can see "Codex is already on this one" before duplicating work.
  const claimsResult = useQuery({ ...workspaceClaimsQuery(workspaceId), retry: false });
  const meResult = useQuery(meQuery);
  const workspaceTransferSettings = useQuery({ ...workspaceTransferSettingsQuery(workspaceId), enabled: Boolean(workspaceId) });
  const workspaceTransferEnabled = workspaceTransferSettings.data?.enabled === true;
  const claimsByDoc = useMemo(() => {
    const map = new Map<string, DocClaimSummary>();
    for (const claim of claimsResult.data?.claims ?? []) {
      if (!claim.active) continue;
      map.set(claim.documentId, { actorLabel: claim.actorLabel, expiresAt: claim.expiresAt });
    }
    return map;
  }, [claimsResult.data]);

  function close() {
    if (busy) return;
    setDialog(null);
    setError(null);
  }
  function open(next: DialogState) {
    if (busy) return;
    setError(null);
    setDialog(next);
  }

  useEffect(() => {
    if (!canCreateRoot) return;
    const openRootFolderDialog = () => open({ kind: "newFolder", parent: null });
    window.addEventListener("pageden:new-root-folder", openRootFolderDialog);
    return () => window.removeEventListener("pageden:new-root-folder", openRootFolderDialog);
  }, [busy, canCreateRoot]);

  function currentDocumentWasEmptied(folderPath: string): boolean {
    const openDoc = documents.find((doc) => doc.id === openDocId || doc.path === openReadablePath);
    return Boolean(openDoc && openDoc.path.startsWith(`${folderPath}/`));
  }

  function folderContentCounts(folder: Folder): { documents: number; folders: number } {
    const prefix = `${folder.path}/`;
    return {
      documents: documents.filter((doc) => doc.path.startsWith(prefix)).length,
      folders: folders.filter((candidate) => candidate.path.startsWith(prefix)).length,
    };
  }

  async function run(
    fn: () => Promise<unknown>,
    opts?: { deletedDocId?: string; emptiedFolderPath?: string; transferredDocId?: string; transferredFolderPath?: string; destinationWorkspaceId?: string },
  ) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
      if (opts?.destinationWorkspaceId) {
        await queryClient.invalidateQueries({ queryKey: treeQuery(opts.destinationWorkspaceId).queryKey });
      }
      // Structural changes can alter descendant document paths/titles — refresh open docs.
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "document" });
      if (opts?.deletedDocId && opts.deletedDocId === openDocId) {
        void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
      }
      if (opts?.emptiedFolderPath && currentDocumentWasEmptied(opts.emptiedFolderPath)) {
        void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
      }
      if (opts?.transferredDocId && opts.transferredDocId === openDocId) {
        void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
      }
      if (opts?.transferredFolderPath && currentDocumentWasEmptied(opts.transferredFolderPath)) {
        void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
      }
      setDialog(null);
    } catch (e) {
      setError(crudErrorMessage(e));
      // The client's optimistic guess was wrong (revoked/hidden/deleted) — resync.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
        void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
        if (opts?.deletedDocId && opts.deletedDocId === openDocId) {
          void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
        }
        if (opts?.emptiedFolderPath && currentDocumentWasEmptied(opts.emptiedFolderPath)) {
          void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
        }
        if (opts?.transferredDocId && opts.transferredDocId === openDocId) {
          void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
        }
        if (opts?.transferredFolderPath && currentDocumentWasEmptied(opts.transferredFolderPath)) {
          void navigate({ to: "/w/$workspaceId", params: { workspaceId } });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const actions: TreeActions = {
    onNewDoc: (folder) => open({ kind: "newDoc", folder }),
    onNewFolder: (parent) => open({ kind: "newFolder", parent }),
    onRenameDoc: (doc) => open({ kind: "renameDoc", doc }),
    onMoveDoc: (doc) => open({ kind: "moveDoc", doc }),
    onTransferDoc: (doc) => open({ kind: "transferDoc", doc }),
    onDeleteDoc: (doc) => open({ kind: "deleteDoc", doc }),
    onRenameFolder: (folder) => open({ kind: "renameFolder", folder }),
    onMoveFolder: (folder) => open({ kind: "moveFolder", folder }),
    onTransferFolder: (folder) => open({ kind: "transferFolder", folder }),
    onEmptyFolder: (folder) => open({ kind: "emptyFolder", folder }),
    onDeleteFolder: (folder) => open({ kind: "deleteFolder", folder }),
    onPermissionsDoc: (doc) => open({ kind: "permsDoc", doc }),
    onPermissionsFolder: (folder) => open({ kind: "permsFolder", folder }),
  };

  const createRootFolder = () => open({ kind: "newFolder", parent: null });

  return (
    <div className="min-h-0 flex flex-1 flex-col">
      {toolbar ? toolbar({ canCreateRoot, createRootFolder }) : canCreateRoot ? (
        <div className="shrink-0 px-1 pb-2">
          <Button variant="ghost" className="w-full justify-start" onClick={createRootFolder}>
            + New top-level folder
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <DocumentTree
          workspaceId={workspaceId}
          folders={folders}
          documents={documents}
          actions={actions}
          onNavigate={onNavigate}
          claims={claimsByDoc}
          workspaceTransferEnabled={workspaceTransferEnabled}
        />
      </div>

      {dialog?.kind === "newDoc" ? (
        <NameDialog
          title={`New document in “${dialog.folder.name}”`}
          nameLabel="Title"
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(name, slug) =>
            run(async () => {
              const result = await api.createDocument({ workspaceId, folderId: dialog.folder.id, title: name, slug });
              return result;
            })
          }
        />
      ) : null}

      {dialog?.kind === "newFolder" ? (
        <NameDialog
          title={dialog.parent ? `New subfolder in “${dialog.parent.name}”` : "New top-level folder"}
          nameLabel="Name"
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(name, slug) =>
            run(async () => {
              const result = await api.createFolder({ workspaceId, parentFolderId: dialog.parent?.id ?? null, name, slug });
              track("folder_created", { source: dialog.parent ? "subfolder" : "root" });
              return result;
            })
          }
        />
      ) : null}

      {dialog?.kind === "renameDoc" ? (
        <NameDialog
          title="Rename document"
          nameLabel="Title"
          initialName={dialog.doc.title}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(name, slug) => run(() => api.renameDocument(dialog.doc.id, { title: name, slug }))}
        />
      ) : null}

      {dialog?.kind === "renameFolder" ? (
        <NameDialog
          title="Rename folder"
          nameLabel="Name"
          initialName={dialog.folder.name}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(name, slug) => run(() => api.renameFolder(dialog.folder.id, { name, slug }))}
        />
      ) : null}

      {dialog?.kind === "moveDoc" ? (
        <MoveDialog
          title={`Move “${dialog.doc.title}”`}
          folders={folders}
          allowRoot={false}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(folderId) => run(() => api.moveDocument(dialog.doc.id, folderId!))}
        />
      ) : null}

      {dialog?.kind === "moveFolder" ? (
        <MoveDialog
          title={`Move “${dialog.folder.name}”`}
          folders={folders.filter((f) => f.id !== dialog.folder.id && !f.path.startsWith(`${dialog.folder.path}/`))}
          allowRoot={canCreateRoot}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(folderId) => run(() => api.moveFolder(dialog.folder.id, folderId))}
        />
      ) : null}

      {dialog?.kind === "transferDoc" ? (
        <WorkspaceTransferDialog
          title={`Move "${dialog.doc.title}" to workspace`}
          currentWorkspaceId={workspaceId}
          workspaces={meResult.data?.workspaces ?? []}
          allowRoot={false}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(destinationWorkspaceId, destinationFolderId) =>
            run(() => api.transferDocumentWorkspace(dialog.doc.id, destinationWorkspaceId, destinationFolderId!), {
              transferredDocId: dialog.doc.id,
              destinationWorkspaceId,
            })
          }
        />
      ) : null}

      {dialog?.kind === "transferFolder" ? (
        <WorkspaceTransferDialog
          title={`Move "${dialog.folder.name}" to workspace`}
          currentWorkspaceId={workspaceId}
          workspaces={meResult.data?.workspaces ?? []}
          allowRoot
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(destinationWorkspaceId, destinationFolderId) =>
            run(() => api.transferFolderWorkspace(dialog.folder.id, destinationWorkspaceId, destinationFolderId), {
              transferredFolderPath: dialog.folder.path,
              destinationWorkspaceId,
            })
          }
        />
      ) : null}

      {dialog?.kind === "deleteDoc" ? (
        <ConfirmDialog
          title="Delete document?"
          message={`“${dialog.doc.title}” will be removed.`}
          busy={busy}
          error={error}
          onClose={close}
          onConfirm={() => run(() => api.deleteDocument(dialog.doc.id), { deletedDocId: dialog.doc.id })}
        />
      ) : null}

      {dialog?.kind === "emptyFolder" ? (
        <EmptyFolderDialog
          folder={dialog.folder}
          counts={folderContentCounts(dialog.folder)}
          busy={busy}
          error={error}
          onClose={close}
          onConfirm={(confirmationName) =>
            run(() => api.emptyFolder(dialog.folder.id, confirmationName), { emptiedFolderPath: dialog.folder.path })
          }
        />
      ) : null}

      {dialog?.kind === "deleteFolder" ? (
        <ConfirmDialog
          title="Delete folder?"
          message={`“${dialog.folder.name}” must be empty to delete.`}
          busy={busy}
          error={error}
          onClose={close}
          onConfirm={() => run(() => api.deleteFolder(dialog.folder.id))}
        />
      ) : null}

      {dialog?.kind === "permsDoc" ? (
        <PermissionsDialog kind="document" id={dialog.doc.id} name={dialog.doc.title} workspaceId={workspaceId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "permsFolder" ? (
        <PermissionsDialog kind="folder" id={dialog.folder.id} name={dialog.folder.name} workspaceId={workspaceId} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function NameDialog({
  title,
  nameLabel,
  initialName = "",
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  nameLabel: string;
  initialName?: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string, slug: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(slugify(initialName));
  const [slugEdited, setSlugEdited] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name.trim(), slug.trim());
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium">{nameLabel}</span>
          <Input
            value={name}
            aria-label={nameLabel}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
            required
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Slug</span>
          <Input
            value={slug}
            aria-label="Slug"
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
            required
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim() || !slug.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  title,
  folders,
  allowRoot,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  folders: Folder[];
  allowRoot: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (folderId: string | null) => void;
}) {
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  const [target, setTarget] = useState<string>(allowRoot ? "" : (sorted[0]?.id ?? ""));
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(target === "" ? null : target);
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium">Destination</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {allowRoot ? <option value="">(top level)</option> : null}
            {sorted.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || (!allowRoot && target === "")}>
            {busy ? "Moving…" : "Move"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function WorkspaceTransferDialog({
  title,
  currentWorkspaceId,
  workspaces,
  allowRoot,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  currentWorkspaceId: string;
  workspaces: Array<{ id: string; name: string }>;
  allowRoot: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (workspaceId: string, folderId: string | null) => void;
}) {
  const destinations = workspaces.filter((workspace) => workspace.id !== currentWorkspaceId);
  const [workspaceId, setWorkspaceId] = useState(destinations[0]?.id ?? "");
  const tree = useQuery({ ...treeQuery(workspaceId), enabled: Boolean(workspaceId) });
  const folders = (tree.data?.folders ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
  const [folderId, setFolderId] = useState<string>("");

  useEffect(() => {
    setFolderId("");
  }, [workspaceId]);

  const canSubmit = Boolean(workspaceId) && (allowRoot || Boolean(folderId));

  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(workspaceId, folderId || null);
        }}
      >
        <p className="text-sm text-slate-600">
          This moves the item out of the current workspace. Explicit item permissions are cleared and destination permissions apply.
        </p>
        {destinations.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">You do not belong to another workspace.</p>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Destination workspace</span>
              <select
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {destinations.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Destination folder</span>
              <select
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                disabled={tree.isLoading}
              >
                {allowRoot ? <option value="">(top level)</option> : <option value="">Select a folder</option>}
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !canSubmit || destinations.length === 0 || tree.isLoading}>
            {busy ? "Moving..." : "Move to workspace"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EmptyFolderDialog({
  folder,
  counts,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  folder: Folder;
  counts: { documents: number; folders: number };
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (confirmationName: string) => void;
}) {
  const [confirmationName, setConfirmationName] = useState("");
  const matches = confirmationName === folder.name;
  return (
    <Dialog title="Empty folder?" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) onConfirm(confirmationName);
        }}
      >
        <div className="space-y-2 text-sm text-slate-600">
          <p>
            This will remove everything inside <span className="font-semibold text-slate-900">"{folder.name}"</span> while keeping the folder.
          </p>
          <p>
            {counts.documents} document{counts.documents === 1 ? "" : "s"} and {counts.folders} subfolder{counts.folders === 1 ? "" : "s"} will be removed.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Type the folder name to confirm</span>
          <Input
            value={confirmationName}
            aria-label="Type the folder name to confirm"
            autoFocus
            onChange={(e) => setConfirmationName(e.target.value)}
            placeholder={folder.name}
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy || !matches}>
            {busy ? "Emptying..." : "Empty folder"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  message,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  message: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="text-sm text-slate-600">{message}</p>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </Dialog>
  );
}
