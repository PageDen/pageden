import { useState } from "react";
import type { z } from "zod";
import { treeSchema } from "@pageden/api-types";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  FilePlus,
  FileText,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  KeyRound,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";

type Tree = z.infer<typeof treeSchema>;
export type Folder = Tree["folders"][number];
export type Doc = Tree["documents"][number];

export interface TreeActions {
  onNewDoc: (folder: Folder) => void;
  onNewFolder: (parent: Folder) => void;
  onRenameDoc: (doc: Doc) => void;
  onMoveDoc: (doc: Doc) => void;
  onDeleteDoc: (doc: Doc) => void;
  onRenameFolder: (folder: Folder) => void;
  onMoveFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onPermissionsDoc: (doc: Doc) => void;
  onPermissionsFolder: (folder: Folder) => void;
}

interface MenuItem {
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  onClick: () => void;
}

function ActionMenu({ items }: { items: MenuItem[] }) {
  if (items.length === 0) return null;

  return (
    <details
      className="relative shrink-0 opacity-0 transition focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <summary
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 [&::-webkit-details-marker]:hidden"
        aria-label="More actions"
        title="More actions"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
        {items.map((item) => (
          <MenuButton key={item.label} item={item} />
        ))}
      </div>
    </details>
  );
}

function MenuButton({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.closest("details")?.removeAttribute("open");
        item.onClick();
      }}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 ${
        item.destructive ? "text-red-600 hover:text-red-700" : "text-slate-700"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span>{item.label}</span>
    </button>
  );
}

const canEdit = (p: string | null) => p === "editor" || p === "manager";
const canManage = (p: string | null) => p === "manager";

// ─── FolderNode ────────────────────────────────────────────────────────────────
// Extracted into its own component so it can hold useState for open/closed.
// Keeping toggle state in React (rather than <details>) ensures the ActionMenu
// (also a <details>) nested in the same row cannot interfere with toggling.

interface FolderNodeProps {
  folder: Folder;
  childFolders: Map<string | null, Folder[]>;
  docsByFolder: Map<string, Doc[]>;
  workspaceId: string;
  actions: TreeActions;
}

function FolderNode({ folder, childFolders, docsByFolder, workspaceId, actions }: FolderNodeProps) {
  const [isOpen, setIsOpen] = useState(true);

  const subFolders = childFolders.get(folder.id) ?? [];
  const docs = docsByFolder.get(folder.id) ?? [];
  const hasChildren = subFolders.length > 0 || docs.length > 0;

  const menuItems: MenuItem[] = [
    ...(canEdit(folder.permission)
      ? [
          { label: "New document", icon: FilePlus, onClick: () => actions.onNewDoc(folder) },
          { label: "New subfolder", icon: FolderPlus, onClick: () => actions.onNewFolder(folder) },
        ]
      : []),
    ...(canManage(folder.permission)
      ? [
          { label: "Rename", icon: Pencil, onClick: () => actions.onRenameFolder(folder) },
          { label: "Move", icon: MoveRight, onClick: () => actions.onMoveFolder(folder) },
          { label: "Permissions", icon: KeyRound, onClick: () => actions.onPermissionsFolder(folder) },
          { label: "Trash", icon: Trash2, destructive: true, onClick: () => actions.onDeleteFolder(folder) },
        ]
      : []),
  ];

  return (
    <li>
      <div
        className="group flex items-center justify-between gap-1 rounded-md py-1 pr-1 font-medium text-slate-700 transition hover:bg-white pl-2"
      >
        {/* Toggle button — only this area collapses/expands */}
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate py-0.5 text-left"
          onClick={() => setIsOpen((o) => !o)}
          aria-expanded={isOpen}
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-slate-400 transition-transform duration-150 ${isOpen ? "rotate-90" : ""} ${!hasChildren ? "invisible" : ""}`}
          />
          {isOpen
            ? <FolderOpen size={15} className="shrink-0 text-slate-400" />
            : <FolderClosed size={15} className="shrink-0 text-slate-400" />}
          <span className="truncate">{folder.name}</span>
        </button>
        <ActionMenu items={menuItems} />
      </div>

      {isOpen && (
        <ul className="relative ml-5 border-l border-slate-200 pl-2">
          {subFolders.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              childFolders={childFolders}
              docsByFolder={docsByFolder}
              workspaceId={workspaceId}
              actions={actions}
            />
          ))}
          {docs.map((d) => (
            <DocRow key={d.id} doc={d} workspaceId={workspaceId} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── DocRow ────────────────────────────────────────────────────────────────────

function DocRow({
  doc,
  workspaceId,
  actions,
}: {
  doc: Doc;
  workspaceId: string;
  actions: TreeActions;
}) {
  const menuItems: MenuItem[] = canManage(doc.permission)
    ? [
        { label: "Rename", icon: Pencil, onClick: () => actions.onRenameDoc(doc) },
        { label: "Move", icon: MoveRight, onClick: () => actions.onMoveDoc(doc) },
        { label: "Permissions", icon: KeyRound, onClick: () => actions.onPermissionsDoc(doc) },
        { label: "Delete", icon: Trash2, destructive: true, onClick: () => actions.onDeleteDoc(doc) },
      ]
    : [];

  return (
    <li className="group relative flex items-center justify-between gap-1 pr-1">
      <Link
        to="/w/$workspaceId/d/$documentId"
        params={{ workspaceId, documentId: doc.id }}
        className="relative flex min-w-0 flex-1 items-center gap-2 truncate rounded-md border border-transparent py-1.5 pl-2 pr-2 text-slate-600 transition hover:bg-white hover:text-slate-900 [&.active]:border-slate-200 [&.active]:bg-white [&.active]:font-medium [&.active]:text-slate-950 [&.active]:shadow-sm"
      >
        <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-transparent [.active_&]:bg-orange-600" />
        <FileText size={15} className="shrink-0 text-slate-400 [.active_&]:text-orange-600" />
        <span className="truncate">{doc.title}</span>
      </Link>
      <ActionMenu items={menuItems} />
    </li>
  );
}

// ─── DocumentTree ──────────────────────────────────────────────────────────────

export function DocumentTree({
  workspaceId,
  folders,
  documents,
  actions,
}: {
  workspaceId: string;
  folders: Folder[];
  documents: Doc[];
  actions: TreeActions;
}) {
  const childFolders = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const bucket = childFolders.get(f.parentFolderId) ?? [];
    bucket.push(f);
    childFolders.set(f.parentFolderId, bucket);
  }
  const folderIds = new Set(folders.map((f) => f.id));
  const docsByFolder = new Map<string, Doc[]>();
  const orphanDocs: Doc[] = [];
  for (const d of documents) {
    if (folderIds.has(d.folderId)) {
      const bucket = docsByFolder.get(d.folderId) ?? [];
      bucket.push(d);
      docsByFolder.set(d.folderId, bucket);
    } else {
      orphanDocs.push(d);
    }
  }

  const roots = childFolders.get(null) ?? [];
  if (roots.length === 0 && documents.length === 0) {
    return <p className="px-2 py-1 text-slate-400">No documents yet.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {roots.map((f) => (
        <FolderNode
          key={f.id}
          folder={f}
          childFolders={childFolders}
          docsByFolder={docsByFolder}
          workspaceId={workspaceId}
          actions={actions}
        />
      ))}
      {orphanDocs.map((d) => (
        <DocRow key={d.id} doc={d} workspaceId={workspaceId} actions={actions} />
      ))}
    </ul>
  );
}
