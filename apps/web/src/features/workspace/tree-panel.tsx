import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ApiError, api, crudErrorMessage } from "../../lib/api";
import { meQuery, treeQuery } from "../../lib/queries";
import { slugify } from "../../lib/slug";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/ui/dialog";
import { DocumentTree, type Doc, type Folder, type TreeActions } from "./document-tree";
import { PermissionsDialog } from "../permissions/permissions-dialog";

type DialogState =
  | { kind: "newDoc"; folder: Folder }
  | { kind: "newFolder"; parent: Folder | null }
  | { kind: "renameDoc"; doc: Doc }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "moveDoc"; doc: Doc }
  | { kind: "moveFolder"; folder: Folder }
  | { kind: "deleteDoc"; doc: Doc }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "permsDoc"; doc: Doc }
  | { kind: "permsFolder"; folder: Folder }
  | null;

export function TreePanel({
  workspaceId,
  folders,
  documents,
  canCreateRoot,
}: {
  workspaceId: string;
  folders: Folder[];
  documents: Doc[];
  canCreateRoot: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const openDocId = params.documentId;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function run(fn: () => Promise<unknown>, opts?: { deletedDocId?: string }) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: treeQuery(workspaceId).queryKey });
      // Structural changes can alter descendant document paths/titles — refresh open docs.
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "document" });
      if (opts?.deletedDocId && opts.deletedDocId === openDocId) {
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
    onDeleteDoc: (doc) => open({ kind: "deleteDoc", doc }),
    onRenameFolder: (folder) => open({ kind: "renameFolder", folder }),
    onMoveFolder: (folder) => open({ kind: "moveFolder", folder }),
    onDeleteFolder: (folder) => open({ kind: "deleteFolder", folder }),
    onPermissionsDoc: (doc) => open({ kind: "permsDoc", doc }),
    onPermissionsFolder: (folder) => open({ kind: "permsFolder", folder }),
  };

  return (
    <div>
      {canCreateRoot ? (
        <div className="mb-2 px-1">
          <Button variant="ghost" className="w-full justify-start" onClick={() => open({ kind: "newFolder", parent: null })}>
            + New top-level folder
          </Button>
        </div>
      ) : null}
      <DocumentTree workspaceId={workspaceId} folders={folders} documents={documents} actions={actions} />

      {dialog?.kind === "newDoc" ? (
        <NameDialog
          title={`New document in “${dialog.folder.name}”`}
          nameLabel="Title"
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(name, slug) =>
            run(() => api.createDocument({ workspaceId, folderId: dialog.folder.id, title: name, slug }))
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
            run(() => api.createFolder({ workspaceId, parentFolderId: dialog.parent?.id ?? null, name, slug }))
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
