import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Bot, Building2, ChevronDown, FileText, Home, KeyRound, LogOut, Monitor, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, ShieldCheck, Sun, UploadCloud, UserRound, X } from "lucide-react";
import type { z } from "zod";
import { searchSchema, treeSchema } from "@pageden/api-types";
import { api } from "../../lib/api";
import { currentWorkspaceQuery, meQuery, searchQuery, treeQuery } from "../../lib/queries";
import { Input } from "../../components/ui/input";
import { TreePanel } from "./tree-panel";
import { CommandPalette } from "./command-palette";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { useDismissableMenu } from "../../lib/use-dismissable-menu";
import { highlightSnippet } from "../../lib/search-highlight";
import { workspaceBaseDomain } from "../../lib/workspace-url";
import { type ThemeMode, useTheme } from "../../lib/theme";

export function WorkspaceShell() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const [searchText, setSearchText] = useState("");
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 256;

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => window.localStorage.getItem("pageden.sidebar.collapsed") === "true");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("pageden.sidebar.width"));
    return stored > 0 ? stored : SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [isMobileFilesOpen, setIsMobileFilesOpen] = useState(false);
  const [showQuickAccess, setShowQuickAccess] = useState(() => window.localStorage.getItem("pageden.quickAccess.dismissed") !== "true");
  const sidebarRef = useRef<HTMLElement>(null);
  const accountMenuRef = useDismissableMenu();

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleResizeReset = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    window.localStorage.setItem("pageden.sidebar.width", String(SIDEBAR_DEFAULT));
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    const offset = sidebarRef.current?.getBoundingClientRect().left ?? 0;
    const newWidth = e.pageX - offset;
    if (newWidth < SIDEBAR_MIN / 2) {
      setIsSidebarCollapsed(true);
      window.localStorage.setItem("pageden.sidebar.collapsed", "true");
      setIsResizing(false);
    } else {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, newWidth)));
    }
  }, []);

  const handleResizeStop = useCallback(() => {
    setIsResizing(false);
    setSidebarWidth((w) => {
      window.localStorage.setItem("pageden.sidebar.width", String(w));
      return w;
    });
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeStop);
    return () => {
      document.removeEventListener("mousemove", handleResizeMove);
      document.removeEventListener("mouseup", handleResizeStop);
    };
  }, [isResizing, handleResizeMove, handleResizeStop]);

  // Lock cursor and suppress text selection while dragging
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    }
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);
  const trimmedSearch = searchText.trim();
  // Debounce so we don't fire a search request on every keystroke.
  const debouncedSearch = useDebouncedValue(trimmedSearch, 250);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const tree = useQuery(treeQuery(workspaceId));
  const search = useQuery({ ...searchQuery(workspaceId, debouncedSearch), enabled: debouncedSearch.length > 0 });
  const theme = useTheme();
  const isRefreshingTree = tree.isFetching && !tree.isLoading;

  const resendVerification = useMutation({ mutationFn: () => api.resendVerification() });
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      void navigate({ to: "/login" });
    },
  });

  const workspace = me.data?.workspaces.find((w) => w.id === workspaceId);
  const workspaceInitial = getWorkspaceInitial(workspace?.name);
  const currentDocument = tree.data?.documents.find((doc) => doc.id === params.documentId);
  const toggleSidebar = () => {
    setIsSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("pageden.sidebar.collapsed", String(next));
      return next;
    });
  };

  useEffect(() => {
    if (!isMobileFilesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMobileFilesOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isMobileFilesOpen]);

  useEffect(() => {
    setIsMobileFilesOpen(false);
  }, [workspaceId]);

  function openMobileSearch() {
    setIsMobileFilesOpen(true);
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>("[data-mobile-document-search]")?.focus();
    }, 0);
  }

  return (
    <div className="flex min-h-screen bg-white">
      <CommandPalette workspaceId={workspaceId} />
      <MobileFilesDrawer
        open={isMobileFilesOpen}
        workspaceId={workspaceId}
        workspaceName={workspace?.name ?? "Workspace"}
        workspaceInitial={workspaceInitial}
        workspaceRole={workspace?.role}
        searchText={searchText}
        setSearchText={setSearchText}
        trimmedSearch={trimmedSearch}
        debouncedSearch={debouncedSearch}
        search={search}
        tree={tree}
        isRefreshingTree={isRefreshingTree}
        onRefresh={() => void tree.refetch()}
        onClose={() => setIsMobileFilesOpen(false)}
      />
      <aside
        ref={sidebarRef}
        className={`${isSidebarCollapsed ? "w-14" : ""} hidden shrink-0 flex-col border-r border-slate-200 bg-slate-50/80 transition-[width] duration-200 lg:flex`}
        style={isSidebarCollapsed ? undefined : { width: sidebarWidth }}
      >
        {isSidebarCollapsed ? (
          <div className="flex h-full flex-col items-center border-r-0 px-2 py-3">
            <button
              type="button"
              onClick={toggleSidebar}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen size={18} aria-hidden="true" />
            </button>
            <Link
              to="/"
              className="mt-3 flex h-9 w-9 items-center justify-center rounded-lg bg-orange-600 text-sm font-semibold text-white shadow-sm"
              title={workspace?.name ? `Switch workspace: ${workspace.name}` : "Switch workspace"}
            >
              {workspaceInitial}
            </Link>
            <button
              type="button"
              onClick={() => {
                toggleSidebar();
                window.setTimeout(() => {
                  document.querySelector<HTMLInputElement>('[aria-label="Search documents"]')?.focus();
                }, 0);
              }}
              className="mt-3 flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
              aria-label="Expand sidebar and search"
              title="Search documents"
            >
              <Search size={18} aria-hidden="true" />
            </button>
            <div className="mt-auto pb-1">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-100 text-orange-700" title={me.data?.user.email ?? "User"}>
                <UserRound size={16} aria-hidden="true" />
              </div>
            </div>
          </div>
        ) : (
          <>
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-3">
          <Link
            to="/"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition hover:bg-white"
            title="Switch workspace"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-orange-600 text-sm font-semibold text-white shadow-sm">
              {workspaceInitial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-5 text-slate-950">{workspace?.name ?? "Workspace"}</span>
              <span className="block truncate text-[11px] leading-4 text-slate-500">PageDen workspace</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={toggleSidebar}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
        </div>
        {me.data && me.data.workspaces.length > 1 ? (
          <div className="border-b border-slate-200 px-3 py-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-500">Workspace</span>
              <span className="relative block">
                <select
                  value={workspaceId}
                  onChange={(e) => void navigate({ to: "/w/$workspaceId", params: { workspaceId: e.target.value } })}
                  className="h-10 w-full appearance-none rounded-md border border-slate-300 bg-white py-2 pl-3 pr-10 text-sm text-slate-700 shadow-sm outline-none transition hover:border-slate-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                >
                  {me.data.workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  size={16}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                />
              </span>
            </label>
          </div>
        ) : null}
        <div className="border-b border-slate-200 px-3 py-3">
          <label className="relative block">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={searchText}
              aria-label="Search documents"
              placeholder="Search documents"
              onChange={(e) => setSearchText(e.target.value)}
              className="h-9 bg-white pl-8 pr-10"
            />
            <span className="pointer-events-none absolute right-2 top-2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400">
              ⌘K
            </span>
          </label>
        </div>
        <nav className="flex-1 overflow-auto px-2.5 py-3 text-sm">
          {!trimmedSearch && showQuickAccess ? (
            <div className="mb-3 rounded-md border border-slate-200 bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Quick access</p>
                <button
                  type="button"
                  onClick={() => {
                    window.localStorage.setItem("pageden.quickAccess.dismissed", "true");
                    setShowQuickAccess(false);
                  }}
                  className="rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close quick access"
                  title="Close quick access"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">Use search or select a document below.</p>
            </div>
          ) : null}
          {trimmedSearch ? (
            <SearchResults
              workspaceId={workspaceId}
              query={debouncedSearch || trimmedSearch}
              isLoading={search.isLoading || debouncedSearch !== trimmedSearch}
              isError={search.isError}
              results={debouncedSearch ? search.data?.results ?? [] : []}
            />
          ) : tree.isLoading ? (
            <p className="px-2 py-1 text-slate-400">Loading…</p>
          ) : tree.isError ? (
            <p className="px-2 py-1 text-red-600">Could not load documents.</p>
          ) : tree.data ? (
            <>
              <Link
                to="/w/$workspaceId"
                params={{ workspaceId }}
                className="mb-3 flex items-center gap-2 rounded-md px-2 py-2 font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 [&.active]:bg-white [&.active]:text-slate-950 [&.active]:shadow-sm"
                activeOptions={{ exact: true }}
              >
                <Home size={16} aria-hidden="true" className="text-slate-400 [.active_&]:text-orange-600" />
                Home
              </Link>
              <div className="mb-1 flex items-center justify-between gap-2 px-2 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Workspace</span>
                <button
                  type="button"
                  onClick={() => void tree.refetch()}
                  disabled={isRefreshingTree}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 disabled:cursor-wait disabled:opacity-60"
                  aria-label={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
                  title={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
                >
                  <RefreshCw size={14} aria-hidden="true" className={isRefreshingTree ? "animate-spin" : ""} />
                </button>
              </div>
              <TreePanel
                workspaceId={workspaceId}
                folders={tree.data.folders}
                documents={tree.data.documents}
                canCreateRoot={workspace?.role === "admin"}
              />
            </>
          ) : null}
        </nav>
        <div className="border-t border-slate-200 p-2.5">
          <div className="relative flex items-center gap-2 rounded-md px-2 py-2 hover:bg-white">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-100 text-orange-700">
              <UserRound size={15} />
            </div>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-slate-900">{me.data?.user.email?.split("@")[0] ?? "User"}</span>
              <span className="block truncate text-[11px] text-slate-400">{me.data?.user.email ?? ""}</span>
            </span>
            <details
              ref={accountMenuRef}
              className="relative shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                // Close the menu when a navigation item is chosen.
                if ((event.target as HTMLElement).closest("a")) {
                  event.currentTarget.removeAttribute("open");
                }
              }}
            >
              <summary
                className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 [&::-webkit-details-marker]:hidden"
                aria-label="Account menu"
                title="Account menu"
              >
                <MoreHorizontal size={17} aria-hidden="true" />
              </summary>
              <div className="absolute bottom-10 right-0 z-30 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1.5 text-sm shadow-xl">
                <Link
                  to="/w/$workspaceId/account"
                  params={{ workspaceId }}
                  className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <UserRound size={15} aria-hidden="true" />
                  Account
                </Link>
                <Link
                  to="/w/$workspaceId/agents"
                  params={{ workspaceId }}
                  className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <Bot size={15} aria-hidden="true" />
                  AI agents
                </Link>
                <Link
                  to="/w/$workspaceId/import"
                  params={{ workspaceId }}
                  className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <UploadCloud size={15} aria-hidden="true" />
                  Import vault
                </Link>
                <Link
                  to="/w/$workspaceId/tokens"
                  params={{ workspaceId }}
                  className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <KeyRound size={15} aria-hidden="true" />
                  Tokens
                </Link>
                {workspace?.role === "admin" ? (
                  <Link
                    to="/w/$workspaceId/admin/users"
                    params={{ workspaceId }}
                    className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                  >
                    <ShieldCheck size={15} aria-hidden="true" />
                    Admin
                  </Link>
                ) : null}
                <Link
                  to="/workspaces/new"
                  className="flex items-center gap-2 px-3 py-2 text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                >
                  <Plus size={15} aria-hidden="true" />
                  Create workspace
                </Link>
                <div className="my-1 border-t border-slate-200" />
                <div className="px-3 py-2">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Theme
                  </div>
                  <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
                    <ThemeChoice mode="light" current={theme.mode} onSelect={theme.setMode} label="Light" icon={Sun} />
                    <ThemeChoice mode="dark" current={theme.mode} onSelect={theme.setMode} label="Dark" icon={Moon} />
                    <ThemeChoice mode="auto" current={theme.mode} onSelect={theme.setMode} label="Auto" icon={Monitor} />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-4 text-slate-400">
                    Auto follows your local time.
                  </p>
                </div>
                <div className="my-1 border-t border-slate-200" />
                <button
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    logout.mutate();
                  }}
                  disabled={logout.isPending}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 hover:text-slate-950 disabled:opacity-50"
                >
                  <LogOut size={15} aria-hidden="true" />
                  {logout.isPending ? "Signing out…" : "Sign out"}
                </button>
              </div>
            </details>
          </div>
        </div>
          </>
        )}
      </aside>
      {!isSidebarCollapsed && (
        <div
          className="group relative z-10 hidden w-2 shrink-0 cursor-col-resize lg:block"
          onMouseDown={handleResizeStart}
          onDoubleClick={handleResizeReset}
          title="Drag to resize · Double-click to reset"
        >
          <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-px transition-colors duration-150 delay-300 ${isResizing ? "bg-orange-500" : "bg-transparent group-hover:bg-slate-300"}`} />
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setIsMobileFilesOpen(true)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
            aria-label="Open files"
            title="Files"
          >
            <PanelLeftOpen size={20} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-950">{currentDocument?.title ?? workspace?.name ?? "Pageden"}</p>
            <p className="truncate text-[11px] text-slate-400">{currentDocument?.path ?? "PageDen workspace"}</p>
          </div>
          <button
            type="button"
            onClick={openMobileSearch}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
            aria-label="Search documents"
            title="Search"
          >
            <Search size={19} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void tree.refetch()}
            disabled={isRefreshingTree}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 disabled:cursor-wait disabled:opacity-60"
            aria-label={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
            title={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
          >
            <RefreshCw size={18} aria-hidden="true" className={isRefreshingTree ? "animate-spin" : ""} />
          </button>
        </div>
        {me.data && !me.data.emailVerified ? (
          <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <span>Please verify your email address to secure your account.</span>
            <button
              type="button"
              onClick={() => resendVerification.mutate()}
              disabled={resendVerification.isPending || resendVerification.isSuccess}
              className="shrink-0 rounded border border-amber-300 px-2 py-0.5 text-amber-900 hover:bg-amber-100 disabled:opacity-60"
            >
              {resendVerification.isSuccess ? "Sent — check your inbox" : resendVerification.isPending ? "Sending…" : "Resend"}
            </button>
          </div>
        ) : null}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function ThemeChoice({
  mode,
  current,
  onSelect,
  label,
  icon: Icon,
}: {
  mode: ThemeMode;
  current: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  label: string;
  icon: typeof Sun;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(mode)}
      className={`inline-flex h-8 items-center justify-center gap-1 rounded px-2 text-[11px] font-medium transition ${
        active ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
      }`}
    >
      <Icon size={13} aria-hidden="true" />
      {label}
    </button>
  );
}

type SearchResult = z.infer<typeof searchSchema>["results"][number];
type SearchData = z.infer<typeof searchSchema>;
type TreeDoc = z.infer<typeof treeSchema>["documents"][number];
type TreeData = z.infer<typeof treeSchema>;

function MobileFilesDrawer({
  open,
  workspaceId,
  workspaceName,
  workspaceInitial,
  workspaceRole,
  searchText,
  setSearchText,
  trimmedSearch,
  debouncedSearch,
  search,
  tree,
  isRefreshingTree,
  onRefresh,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  workspaceInitial: string;
  workspaceRole?: string;
  searchText: string;
  setSearchText: (value: string) => void;
  trimmedSearch: string;
  debouncedSearch: string;
  search: UseQueryResult<SearchData>;
  tree: UseQueryResult<TreeData>;
  isRefreshingTree: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={`absolute inset-0 bg-slate-950/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
        aria-label="Close files"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Files"
        className={`relative flex h-full w-[min(92vw,390px)] flex-col border-r border-slate-200 bg-slate-50 shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 px-4">
          <Link
            to="/"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-base font-semibold text-white shadow-sm"
            title="Switch workspace"
          >
            {workspaceInitial}
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-slate-950">{workspaceName}</p>
            <p className="truncate text-xs text-slate-500">PageDen workspace</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
            aria-label="Close files"
            title="Close"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <label className="relative block">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              value={searchText}
              data-mobile-document-search
              aria-label="Search documents"
              placeholder="Search documents"
              onChange={(e) => setSearchText(e.target.value)}
              className="h-10 bg-white pl-9 pr-10"
            />
            {searchText ? (
              <button
                type="button"
                onClick={() => setSearchText("")}
                className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Clear search"
                title="Clear search"
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : null}
          </label>
        </div>

        <nav className="min-h-0 flex-1 overflow-auto px-3 py-3 text-[15px]">
          {trimmedSearch ? (
            <SearchResults
              workspaceId={workspaceId}
              query={debouncedSearch || trimmedSearch}
              isLoading={search.isLoading || debouncedSearch !== trimmedSearch}
              isError={search.isError}
              results={debouncedSearch ? search.data?.results ?? [] : []}
              onNavigate={onClose}
            />
          ) : tree.isLoading ? (
            <p className="px-2 py-2 text-slate-400">Loading…</p>
          ) : tree.isError ? (
            <p className="px-2 py-2 text-red-600">Could not load documents.</p>
          ) : tree.data ? (
            <>
              <Link
                to="/w/$workspaceId"
                params={{ workspaceId }}
                onClick={onClose}
                className="mb-3 flex items-center gap-2 rounded-lg px-2.5 py-2.5 font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 [&.active]:bg-white [&.active]:text-slate-950 [&.active]:shadow-sm"
                activeOptions={{ exact: true }}
              >
                <Home size={18} aria-hidden="true" className="text-slate-400 [.active_&]:text-orange-600" />
                Home
              </Link>
              <div className="mb-1 flex items-center justify-between gap-2 px-2 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Workspace</span>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={isRefreshingTree}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 disabled:cursor-wait disabled:opacity-60"
                  aria-label={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
                  title={isRefreshingTree ? "Refreshing documents" : "Refresh documents"}
                >
                  <RefreshCw size={15} aria-hidden="true" className={isRefreshingTree ? "animate-spin" : ""} />
                </button>
              </div>
              <TreePanel
                workspaceId={workspaceId}
                folders={tree.data.folders}
                documents={tree.data.documents}
                canCreateRoot={workspaceRole === "admin"}
                onNavigate={onClose}
              />
            </>
          ) : null}
        </nav>

        <div className="grid shrink-0 grid-cols-3 gap-2 border-t border-slate-200 bg-white/80 px-3 py-3">
          <Link
            to="/w/$workspaceId/import"
            params={{ workspaceId }}
            onClick={onClose}
            className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <UploadCloud size={16} aria-hidden="true" />
            Import
          </Link>
          <Link
            to="/w/$workspaceId/agents"
            params={{ workspaceId }}
            onClick={onClose}
            className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <Bot size={16} aria-hidden="true" />
            Agents
          </Link>
          <Link
            to="/w/$workspaceId/account"
            params={{ workspaceId }}
            onClick={onClose}
            className="flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-950"
          >
            <UserRound size={16} aria-hidden="true" />
            Account
          </Link>
        </div>
      </section>
    </div>
  );
}

function SearchResults({
  workspaceId,
  query,
  isLoading,
  isError,
  results,
  onNavigate,
}: {
  workspaceId: string;
  query: string;
  isLoading: boolean;
  isError: boolean;
  results: SearchResult[];
  onNavigate?: () => void;
}) {
  if (isLoading) return <p className="px-2 py-1 text-slate-400">Searching…</p>;
  if (isError) return <p className="px-2 py-1 text-red-600">Could not search documents.</p>;
  if (results.length === 0) {
    return <p className="px-2 py-1 text-slate-400">No results for “{query}”.</p>;
  }
  return (
    <ul className="space-y-1">
      {results.map((result) => (
        <li key={result.id}>
          <Link
            to="/w/$workspaceId/d/$documentId"
            params={{ workspaceId, documentId: result.id }}
            onClick={onNavigate}
            className="block rounded px-2 py-1.5 hover:bg-slate-100 [&.active]:bg-slate-200"
          >
            <span className="block truncate text-slate-700">📄 {result.title}</span>
            <span className="block truncate text-xs text-slate-400">{result.path}</span>
            {result.snippet ? (
              <span className="mt-0.5 block text-xs leading-snug text-slate-500 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                {highlightSnippet(result.snippet)}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function WorkspaceEmptyState() {
  const params = useParams({ strict: false });
  const workspaceId = params.workspaceId ?? "";
  const tree = useQuery(treeQuery(workspaceId));
  const currentWorkspace = useQuery(currentWorkspaceQuery);
  const [tab, setTab] = useState<HomeTab>("recent");

  if (tree.isLoading) {
    return <div className="flex min-h-screen items-center justify-center p-8 text-slate-400">Loading home...</div>;
  }

  if (tree.isError) {
    return <div className="flex min-h-screen items-center justify-center p-8 text-red-600">Could not load workspace home.</div>;
  }

  const docs = tree.data?.documents ?? [];
  const folders = tree.data?.folders ?? [];
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const visibleDocs = documentsForHomeTab(docs, tab);

  const isCloud = currentWorkspace.data?.routingMode !== "self_hosted";

  if (isCloud && docs.length === 0 && folders.length === 0) {
    return <OnboardingView workspaceId={workspaceId} />;
  }

  return (
    <div className="min-h-screen px-8 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">Pageden</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">Home</h1>
        </div>

        <div className="mb-7 flex flex-wrap gap-6 border-b border-slate-200">
          {homeTabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`border-b-2 px-0 pb-3 text-sm font-medium transition ${
                tab === item.id
                  ? "border-orange-600 text-slate-950"
                  : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {visibleDocs.length > 0 ? (
          <ul className="space-y-1">
            {visibleDocs.map((doc) => (
              <HomeDocumentRow key={doc.id} workspaceId={workspaceId} doc={doc} folderName={foldersById.get(doc.folderId)?.name ?? "Workspace"} />
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 px-5 py-8 text-center">
            <FileText className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-slate-700">No documents yet</p>
            <p className="mt-1 text-sm text-slate-400">Create a document from the sidebar to see it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function OnboardingView({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="min-h-screen px-8 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-10">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">Welcome to Pageden</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Your workspace is ready</h1>
          <p className="mt-2 text-base text-slate-500">Here are a few ways to get started.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <OnboardingCard
            icon={<FileText size={22} aria-hidden="true" />}
            title="Write your first document"
            description="Use the sidebar on the left to create a folder and add your first document. Your team can view and edit it together."
            action={
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-700">
                Use the sidebar <ArrowRight size={14} aria-hidden="true" />
              </span>
            }
          />

          <OnboardingCard
            icon={<UploadCloud size={22} aria-hidden="true" />}
            title="Bring in your Obsidian notes"
            description="Already have notes in Obsidian? Import your vault and everything will be searchable and editable right here."
            action={
              <Link
                to="/w/$workspaceId/import"
                params={{ workspaceId }}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:text-orange-800"
              >
                Import vault <ArrowRight size={14} aria-hidden="true" />
              </Link>
            }
          />

          <OnboardingCard
            icon={<Bot size={22} aria-hidden="true" />}
            title="Connect your AI assistant"
            description="Give Claude, Codex, or any AI tool instant access to your workspace. Ask questions, get summaries, and write new content without leaving your AI app."
            action={
              <Link
                to="/w/$workspaceId/agents"
                params={{ workspaceId }}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:text-orange-800"
              >
                Set up AI access <ArrowRight size={14} aria-hidden="true" />
              </Link>
            }
          />
        </div>
      </div>
    </div>
  );
}

function OnboardingCard({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
        {icon}
      </div>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="mt-1.5 flex-1 text-sm leading-6 text-slate-500">{description}</p>
      <div className="mt-4">{action}</div>
    </div>
  );
}

type HomeTab = "recent" | "popular" | "updated" | "mine";

const homeTabs: Array<{ id: HomeTab; label: string }> = [
  { id: "recent", label: "Recently viewed" },
  { id: "popular", label: "Popular" },
  { id: "updated", label: "Recently updated" },
  { id: "mine", label: "Created by me" },
];

function documentsForHomeTab(docs: TreeDoc[], tab: HomeTab): TreeDoc[] {
  const byUpdated = [...docs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (tab === "popular") {
    return [...docs].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 12);
  }
  if (tab === "recent") {
    const viewed = readViewedDocumentIds();
    const viewedDocs = viewed.flatMap((id) => docs.find((doc) => doc.id === id) ?? []);
    const viewedIds = new Set(viewedDocs.map((doc) => doc.id));
    return [...viewedDocs, ...byUpdated.filter((doc) => !viewedIds.has(doc.id))].slice(0, 12);
  }
  return byUpdated.slice(0, 12);
}

function readViewedDocumentIds(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("pageden.recentDocuments") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function rememberViewedDocument(id: string): void {
  const next = [id, ...readViewedDocumentIds().filter((existing) => existing !== id)].slice(0, 20);
  window.localStorage.setItem("pageden.recentDocuments", JSON.stringify(next));
}

function HomeDocumentRow({ workspaceId, doc, folderName }: { workspaceId: string; doc: TreeDoc; folderName: string }) {
  return (
    <li>
      <Link
        to="/w/$workspaceId/d/$documentId"
        params={{ workspaceId, documentId: doc.id }}
        onClick={() => rememberViewedDocument(doc.id)}
        className="group flex items-start gap-3 rounded-lg px-2 py-3 transition hover:bg-slate-50"
      >
        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400 transition group-hover:text-orange-600" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold text-slate-900">{doc.title}</span>
          <span className="mt-1 block truncate text-sm text-slate-500">
            Updated {formatRelativeTime(doc.updatedAt)} in {folderName} <span aria-hidden="true">·</span> {doc.path}
          </span>
        </span>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-300 opacity-0 transition group-hover:translate-x-0.5 group-hover:text-orange-600 group-hover:opacity-100" aria-hidden="true" />
      </Link>
    </li>
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} hr ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} day${Math.floor(diff / day) === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp));
}

function getWorkspaceInitial(name: string | null | undefined): string {
  return name?.trim().charAt(0).toUpperCase() || "P";
}

export function WorkspaceChooser() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      void navigate({ to: "/login" });
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-7 shadow-sm">
        <div className="mb-6 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-base font-semibold text-white shadow-sm">
            P
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">PageDen</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Choose a workspace</h1>
            <p className="mt-1 text-sm leading-6 text-slate-500">Use one account across every company you belong to.</p>
          </div>
        </div>

        <div className="space-y-2.5">
          {me.data?.workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              to="/w/$workspaceId"
              params={{ workspaceId: workspace.id }}
              className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 transition hover:border-orange-200 hover:bg-orange-50/40 hover:shadow-sm"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-600 group-hover:bg-orange-100 group-hover:text-orange-700">
                {workspace.name.trim().charAt(0).toUpperCase() || <Building2 size={17} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900">{workspace.name}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
                  <span className="truncate">
                    {workspace.subdomain ? `${workspace.subdomain}.${workspaceBaseDomain}` : workspace.slug}
                  </span>
                  <span aria-hidden="true" className="text-slate-300">·</span>
                  <span className="shrink-0 capitalize">{workspace.role}</span>
                </span>
              </span>
              <ArrowRight size={16} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-orange-600" />
            </Link>
          ))}
        </div>

        <div className="mt-6 border-t border-slate-200 pt-5">
          <Link
            to="/workspaces/new"
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-orange-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-orange-700"
          >
            <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
            Create another workspace
          </Link>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-slate-400">
            <span>Signed in as {me.data?.user.email ?? "your account"}</span>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="inline-flex items-center gap-1 font-medium text-orange-700 transition hover:text-orange-800 hover:underline disabled:opacity-60"
            >
              <LogOut size={12} aria-hidden="true" />
              {logout.isPending ? "Switching..." : "Switch user"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
