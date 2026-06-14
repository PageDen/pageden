import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { PagedenApiClient, PagedenApiError } from "./api-client";
import { ServerMetaStore } from "./metadata";
import {
  conflictSiblingPath,
  downloadDocument,
  pushOrCreateLocalDocument,
  runBackgroundSyncPass,
  type SyncPassSummary,
  type VaultLike,
} from "./sync";
import { createDebouncer, createSyncRunner } from "./runner";
import { canonicalize, checksum } from "./checksum";
import { buildVaultImportPreview, importVaultToPageden, type VaultImportFile, type VaultImportReport } from "./import-vault";
import type { DeviceStartResponse, MeResponse, PagedenSettings, RemoteDocument, RemoteTree, SearchResult } from "./types";

const PUSH_DEBOUNCE_MS = 2000;
const REMOTE_WRITE_GUARD_MS = 1500;
const LIVE_VIEW_TYPE = "pageden-live-document";

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});
turndown.use(gfm);

const DEFAULT_SETTINGS: PagedenSettings = {
  serverUrl: "https://go.pageden.app",
  token: "",
  workspaceId: "",
  remoteDocsFolder: "Remote Docs",
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 5,
  userName: "",
  workspaceName: "",
};

export default class PagedenPlugin extends Plugin {
  settings: PagedenSettings = DEFAULT_SETTINGS;
  private metaStore!: ServerMetaStore;
  private statusBarEl?: HTMLElement;
  private syncRunner!: ReturnType<typeof createSyncRunner>;
  private pushDebouncer!: ReturnType<typeof createDebouncer>;
  private readonly applyingRemoteWrites = new Set<string>();
  private syncIntervalId?: number;
  private lastSummary?: SyncPassSummary;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.metaStore = new ServerMetaStore(this.app.vault.adapter, this.pluginDir());

    this.addSettingTab(new PagedenSettingTab(this.app, this));
    this.registerView(LIVE_VIEW_TYPE, (leaf) => new LiveDocumentView(leaf, this));

    this.addCommand({
      id: "validate-connection",
      name: "Validate connection",
      callback: () => void this.validateConnection(),
    });

    this.addCommand({
      id: "browse-remote-documents",
      name: "Browse remote documents",
      callback: () => void this.openRemoteBrowser(),
    });

    this.addCommand({
      id: "search-remote-documents",
      name: "Search remote documents",
      callback: () => void this.openRemoteSearch(),
    });

    this.addCommand({
      id: "import-vault",
      name: "Import this vault to Pageden",
      callback: () => void this.openVaultImport(),
    });

    this.addCommand({
      id: "open-live-document",
      name: "Open live document",
      callback: () => void this.openLiveDocumentPicker(),
    });

    this.addCommand({
      id: "device-code-login",
      name: "Log in with device code",
      callback: () => void this.startDeviceLogin(),
    });

    this.addCommand({
      id: "push-active-document",
      name: "Push active document",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canPush = file instanceof TFile && file.extension === "md";
        if (checking) return canPush;
        if (file) void this.pushFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "download-folder",
      name: "Download a Pageden folder",
      callback: () => void this.openFolderDownload(),
    });

    this.addCommand({
      id: "download-all-documents",
      name: "Download all Pageden documents",
      callback: () => void this.downloadAllDocuments(),
    });

    this.addCommand({
      id: "resolve-conflict",
      name: "Resolve conflict for this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canResolve = file instanceof TFile && file.extension === "md" && !file.path.endsWith(".conflict.md");
        if (checking) return canResolve;
        if (file) void this.resolveConflict(file);
        return true;
      },
    });

    // Background sync wiring.
    this.statusBarEl = this.addStatusBarItem();
    this.syncRunner = createSyncRunner(() => this.runSyncPass());
    this.pushDebouncer = createDebouncer(PUSH_DEBOUNCE_MS);

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncRunner.run(),
    });

    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileChanged(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultFileChanged(file)));
    this.app.workspace.onLayoutReady(() => this.startAutoSync());
  }

  onunload(): void {
    this.stopAutoSync();
  }

  // Start (or restart) the auto-sync interval. Safe to call repeatedly — e.g. when settings change.
  startAutoSync(): void {
    this.stopAutoSync();
    if (!this.settings.autoSyncEnabled) {
      this.setStatusIdle();
      return;
    }
    const minutes = Math.max(1, Math.floor(Number(this.settings.autoSyncIntervalMinutes)) || DEFAULT_SETTINGS.autoSyncIntervalMinutes);
    this.syncIntervalId = window.setInterval(() => void this.syncRunner.run(), minutes * 60_000);
    this.registerInterval(this.syncIntervalId);
    if (this.isConfigured()) void this.syncRunner.run();
    else this.setStatus("Pageden: not connected");
  }

  private stopAutoSync(): void {
    if (this.syncIntervalId !== undefined) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = undefined;
    }
    this.pushDebouncer?.cancelAll();
  }

  isConfigured(): boolean {
    return Boolean(this.settings.serverUrl.trim() && this.settings.token.trim() && this.settings.workspaceId.trim());
  }

  // One full pull/push reconciliation pass. Serialised by syncRunner; never throws into Obsidian.
  private async runSyncPass(): Promise<void> {
    if (!this.settings.autoSyncEnabled || !this.isConfigured()) return;
    this.setStatus("Pageden: syncing\u2026");
    try {
      const summary = await runBackgroundSyncPass(this.backgroundSyncDeps());
      this.lastSummary = summary;
      this.renderSummary(summary);
    } catch {
      // Network/top-level failure: pause quietly, retry next tick. No noisy popups.
      this.setStatus("Pageden: offline");
    }
  }

  private onVaultFileChanged(file: unknown): void {
    if (!this.settings.autoSyncEnabled || !this.isConfigured()) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const path = file.path;
    if (path.endsWith(".conflict.md")) return;
    if (this.applyingRemoteWrites.has(path)) return; // our own pull write — don't echo it back
    this.pushDebouncer.schedule(path, () => void this.debouncedPush(path));
  }

  private async debouncedPush(path: string): Promise<void> {
    // Don't push during a full pass; reschedule so the edit is not dropped.
    if (this.syncRunner.isRunning()) {
      this.pushDebouncer.schedule(path, () => void this.debouncedPush(path));
      return;
    }
    try {
      const meta = await this.metaStore.getByLocalPath(path);
      if (meta?.permission === "viewer") return;
      if (!meta && !isUnderRemoteDocsFolder(this.settings.remoteDocsFolder, path)) return;
      // Don't auto-push while an unresolved conflict copy exists — wait for the user to resolve it.
      if (await this.app.vault.adapter.exists(conflictSiblingPath(path))) return;
      const localCanonical = canonicalize(await this.app.vault.adapter.read(path));
      // Checksum gate: identical to the last-synced content means a remote write or a no-op save,
      // not a real edit — skip to avoid pull/push ping-pong (covers delayed modify events too).
      if (meta && (await checksum(localCanonical)) === meta.checksum) return;
      const result = await pushOrCreateLocalDocument(this.createSyncDeps(), path);
      if (result.status === "conflict") this.setStatus("Pageden: conflict");
      else if (result.status === "pushed" || result.status === "created") this.setStatusIdle();
    } catch {
      this.setStatus("Pageden: error");
    }
  }

  private backgroundSyncDeps() {
    const base = this.syncDeps();
    return {
      ...base,
      vault: this.guardedVault(base.vault),
      workspaceId: this.settings.workspaceId,
      localMarkdownPaths: async () =>
        this.app.vault
          .getFiles()
          .filter((file) => file.extension === "md" && isUnderRemoteDocsFolder(this.settings.remoteDocsFolder, file.path))
          .map((file) => file.path),
    };
  }

  // Wrap vault writes so a background pull marks the path as remote-applied; the modify handler
  // skips it (belt to the checksum gate's suspenders).
  private guardedVault(base: VaultLike): VaultLike {
    return {
      ...base,
      write: async (path: string, content: string) => {
        this.applyingRemoteWrites.add(path);
        try {
          await base.write(path, content);
        } finally {
          window.setTimeout(() => this.applyingRemoteWrites.delete(path), REMOTE_WRITE_GUARD_MS);
        }
      },
      writeBinary: base.writeBinary
        ? async (path: string, content: ArrayBuffer) => {
            this.applyingRemoteWrites.add(path);
            try {
              await base.writeBinary?.(path, content);
            } finally {
              window.setTimeout(() => this.applyingRemoteWrites.delete(path), REMOTE_WRITE_GUARD_MS);
            }
          }
        : undefined,
    };
  }

  private setStatus(text: string): void {
    this.statusBarEl?.setText(text);
  }

  private setStatusIdle(): void {
    const s = this.lastSummary;
    if (s && s.conflicts) {
      this.setStatus(`Pageden: ${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"} \u2014 run "Resolve conflict" to fix`);
    } else if (s && (s.created || s.pulled || s.pushed)) {
      this.setStatus(`Pageden: synced (${s.created} created, ${s.pushed} sent, ${s.pulled} received)`);
    } else {
      this.setStatus("Pageden: up to date");
    }
  }

  private renderSummary(s: SyncPassSummary): void {
    if (s.errors) this.setStatus("Pageden: sync error \u2014 will retry");
    else if (s.conflicts) this.setStatus(`Pageden: ${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"} \u2014 run "Resolve conflict" to fix`);
    else this.setStatus(`Pageden: synced (${s.created} created, ${s.pushed} sent, ${s.pulled} received)`);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<PagedenSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  api(): PagedenApiClient {
    return new PagedenApiClient(this.settings.serverUrl, this.settings.token);
  }

  liveBaseUrl(): string {
    return `${this.settings.serverUrl.replace(/\/+$/, "")}/api/live`;
  }

  publicApi(): PagedenApiClient {
    return new PagedenApiClient(this.settings.serverUrl, "");
  }

  async validateConnection(): Promise<void> {
    try {
      this.requireConfigured();
      await this.api().validate();
      new Notice("Pageden connection is valid.");
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async openRemoteBrowser(): Promise<void> {
    try {
      this.requireConfigured();
      const tree = await this.api().tree(this.settings.workspaceId);
      new RemoteDocumentModal(this.app, tree, (doc) => void this.download(doc)).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async openRemoteSearch(): Promise<void> {
    try {
      this.requireConfigured();
      new RemoteSearchModal(this.app, this).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async openVaultImport(): Promise<void> {
    try {
      this.requireConfigured();
      const files = this.vaultImportFiles();
      const tree = await this.api().tree(this.settings.workspaceId);
      new VaultImportModal(this.app, this, files, tree).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async openLiveDocumentPicker(): Promise<void> {
    try {
      this.requireConfigured();
      const tree = await this.api().tree(this.settings.workspaceId);
      new RemoteDocumentModal(this.app, tree, (doc) => void this.openLiveDocument(doc), "Open live").open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async searchRemote(query: string): Promise<SearchResult[]> {
    const response = await this.api().search(this.settings.workspaceId, query);
    return response.results;
  }

  async downloadSearchResult(result: SearchResult): Promise<void> {
    await this.download({
      id: result.id,
      folderId: "",
      title: result.title,
      path: result.path,
      permission: result.permission,
      version: null,
      checksum: null,
    });
  }

  async startDeviceLogin(): Promise<void> {
    try {
      if (!this.settings.serverUrl.trim()) throw new Error("Set a Pageden server URL first.");
      const request = await this.publicApi().deviceStart();
      new DeviceLoginModal(this.app, this, request).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async pollDeviceLogin(deviceCode: string): Promise<"pending" | "done"> {
    const result = await this.publicApi().devicePoll(deviceCode);
    if (result.status === "pending") return "pending";
    if (result.status === "approved") {
      this.settings.token = result.token;
      try {
        const me = await new PagedenApiClient(this.settings.serverUrl, result.token).me();
        this.settings.userName = me.user.name;
        const [onlyWorkspace] = me.workspaces;
        if (onlyWorkspace && me.workspaces.length === 1) {
          const ws = onlyWorkspace;
          this.settings.workspaceId = ws.id;
          this.settings.workspaceName = ws.name;
          await this.saveSettings();
          this.startAutoSync();
          new Notice(`Connected! Signed in as ${me.user.name}, workspace "${ws.name}".`);
        } else if (me.workspaces.length > 1) {
          await this.saveSettings();
          new WorkspacePickerModal(this.app, this, me.workspaces).open();
        } else {
          await this.saveSettings();
          this.startAutoSync();
          new Notice(`Connected as ${me.user.name}. No workspaces found — create one in Pageden first.`);
        }
      } catch {
        await this.saveSettings();
        this.startAutoSync();
        new Notice("Login approved. Open Settings → Pageden to select a workspace.");
      }
      return "done";
    }
    if (result.status === "denied") new Notice("Login was cancelled.");
    else if (result.status === "expired") new Notice("Login code expired. Please try again.");
    else new Notice(`Login ${result.status}.`);
    return "done";
  }

  async download(doc: RemoteDocument): Promise<void> {
    try {
      const result = await downloadDocument(this.syncDeps(), doc);
      new Notice(`Downloaded ${result.localPath}`);
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async openLiveDocument(doc: Pick<RemoteDocument, "id" | "permission">): Promise<void> {
    try {
      this.requireConfigured();
      if (doc.permission === "viewer") {
        new Notice("Live editing requires editor or manager permission.");
        return;
      }
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: LIVE_VIEW_TYPE, active: true });
      if (leaf.view instanceof LiveDocumentView) await leaf.view.openDocument(doc.id);
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async pushFile(file: TFile): Promise<void> {
    try {
      this.requireConfigured();
      const result = await pushOrCreateLocalDocument(this.createSyncDeps(), file.path);
      if (result.status === "blocked_viewer") {
        new Notice("This remote document is viewer-only, so it cannot be pushed.");
      } else if (result.status === "conflict") {
        new Notice(
          `Your changes conflict with a newer server version.\nThe server version was saved as "${result.conflictPath}".\nUse the "Resolve conflict for this note" command to dismiss it.`,
          8000,
        );
      } else {
        new Notice(result.status === "created" ? "Created in Pageden." : "Pushed to Pageden.");
      }
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async importVault(files: VaultImportFile[], targetRootName: string, onProgress?: (current: number, total: number) => void): Promise<VaultImportReport> {
    this.requireConfigured();
    return importVaultToPageden({
      api: this.api(),
      vault: this.vaultAdapter(),
      meta: this.metaStore,
      workspaceId: this.settings.workspaceId,
      files,
      targetRootName,
      ignoredRootDirs: [this.app.vault.configDir],
      onProgress,
    });
  }

  async openFolderDownload(): Promise<void> {
    try {
      this.requireConfigured();
      const tree = await this.api().tree(this.settings.workspaceId);
      new FolderDownloadModal(this.app, this, tree).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async downloadFolderDocuments(folderId: string, folderName: string, tree: RemoteTree): Promise<void> {
    try {
      const docs = tree.documents.filter((d) => d.folderId === folderId);
      if (docs.length === 0) {
        new Notice(`No documents found in "${folderName}".`);
        return;
      }
      new Notice(`Downloading ${docs.length} note${docs.length === 1 ? "" : "s"} from "${folderName}"…`, 3000);
      let downloaded = 0;
      let failed = 0;
      for (const doc of docs) {
        try {
          await downloadDocument(this.syncDeps(), doc);
          downloaded++;
        } catch {
          failed++;
        }
      }
      new Notice(
        failed > 0
          ? `Downloaded ${downloaded} of ${docs.length} notes from "${folderName}". ${failed} failed.`
          : `Downloaded ${downloaded} note${downloaded === 1 ? "" : "s"} from "${folderName}".`,
      );
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async downloadAllDocuments(): Promise<void> {
    try {
      this.requireConfigured();
      const tree = await this.api().tree(this.settings.workspaceId);
      if (tree.documents.length === 0) {
        new Notice("No documents found in your Pageden workspace.");
        return;
      }
      new Notice(`Downloading ${tree.documents.length} note${tree.documents.length === 1 ? "" : "s"}…`, 3000);
      let downloaded = 0;
      let failed = 0;
      for (const doc of tree.documents) {
        try {
          await downloadDocument(this.syncDeps(), doc);
          downloaded++;
        } catch {
          failed++;
        }
      }
      new Notice(
        failed > 0
          ? `Downloaded ${downloaded} of ${tree.documents.length} notes. ${failed} failed.`
          : `Downloaded all ${downloaded} note${downloaded === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  async resolveConflict(file: TFile): Promise<void> {
    const conflictPath = conflictSiblingPath(file.path);
    if (!(await this.app.vault.adapter.exists(conflictPath))) {
      new Notice("No conflict file found for this note.");
      return;
    }
    await this.app.vault.adapter.remove(conflictPath);
    new Notice("Conflict resolved — the server copy has been removed.");
  }

  private syncDeps() {
    return {
      api: this.api(),
      vault: this.vaultAdapter(),
      meta: this.metaStore,
      remoteDocsFolder: this.settings.remoteDocsFolder,
    };
  }

  private createSyncDeps() {
    return {
      ...this.syncDeps(),
      workspaceId: this.settings.workspaceId,
    };
  }

  private vaultAdapter(): VaultLike {
    const adapter = this.app.vault.adapter;
    return {
      read: (path) => adapter.read(path),
      write: (path, content) => adapter.write(path, content),
      readBinary: (path) => adapter.readBinary(path),
      writeBinary: (path, content) => adapter.writeBinary(path, content),
      exists: (path) => adapter.exists(path),
      mkdir: (path) => adapter.mkdir(path),
    };
  }

  private vaultImportFiles(): VaultImportFile[] {
    return this.app.vault.getFiles().map((file) => ({
      path: file.path,
      name: file.name,
      extension: file.extension,
    }));
  }

  private pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  private requireConfigured(): void {
    if (!this.settings.serverUrl.trim()) throw new Error("Please set your Pageden server URL in settings.");
    if (!this.settings.token.trim()) throw new Error("Please connect to Pageden first. Open Settings → Pageden and click \"Connect to Pageden\".");
    if (!this.settings.workspaceId.trim()) throw new Error("Please select a workspace. Open Settings → Pageden and click \"Connect to Pageden\".");
  }
}

class LiveDocumentView extends ItemView {
  private editor?: Editor;
  private provider?: WebsocketProvider;
  private ydoc?: Y.Doc;
  private documentId?: string;
  private baseVersion = "";
  private lastSavedMarkdown = "";
  private statusEl?: HTMLElement;
  private titleEl?: HTMLElement;
  private pathEl?: HTMLElement;
  private saveTimer?: number;
  private saving = false;
  private saveAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: PagedenPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LIVE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.titleEl?.getText() || "Pageden live document";
  }

  async openDocument(documentId: string): Promise<void> {
    this.destroyLiveSession();
    this.documentId = documentId;
    this.contentEl.empty();
    this.contentEl.addClass("pageden-live-view");

    const header = this.contentEl.createDiv({ cls: "pageden-live-header" });
    const titleWrap = header.createDiv();
    this.titleEl = titleWrap.createEl("h2", { text: "Loading..." });
    this.pathEl = titleWrap.createEl("p", { text: "Connecting to Pageden" });
    this.statusEl = header.createEl("span", { text: "Connecting", cls: "pageden-live-status" });

    const toolbar = this.contentEl.createDiv({ cls: "pageden-live-toolbar" });
    const editorEl = this.contentEl.createDiv({ cls: "pageden-live-editor" });

    const remote = await this.plugin.api().getDocument(documentId);
    if (remote.permission === "viewer") throw new Error("Live editing requires editor or manager permission.");
    this.baseVersion = remote.version ?? "";
    this.lastSavedMarkdown = remote.content;
    this.titleEl.setText(remote.title);
    this.pathEl.setText(remote.path);

    this.ydoc = new Y.Doc();
    this.provider = new WebsocketProvider(this.plugin.liveBaseUrl(), documentId, this.ydoc, {
      params: { token: this.plugin.settings.token },
      connect: true,
      disableBc: true,
    });

    this.editor = new Editor({
      element: editorEl,
      extensions: [
        StarterKit.configure({ link: false, undoRedo: false }),
        Collaboration.configure({ document: this.ydoc }),
        Link.configure({ autolink: true, openOnClick: false, protocols: ["http", "https", "mailto"] }),
        Placeholder.configure({ placeholder: "Start writing..." }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
      ],
      editorProps: {
        attributes: { class: "pageden-live-prosemirror" },
      },
      onUpdate: ({ editor }) => {
        const markdown = htmlToMarkdown(editor.getHTML());
        if (markdown !== this.lastSavedMarkdown) this.scheduleSave();
      },
    });

    this.renderToolbar(toolbar);
    this.provider.on("status", (event: { status: string }) => this.setStatus(event.status === "connected" ? "Live" : "Reconnecting"));
    this.provider.on("sync", (synced: boolean) => {
      if (synced) this.seedInitialContent(remote.content);
    });
    if (this.provider.synced) this.seedInitialContent(remote.content);
  }

  async onClose(): Promise<void> {
    this.destroyLiveSession();
  }

  private renderToolbar(toolbar: HTMLElement): void {
    const buttons: Array<[string, () => void]> = [
      ["B", () => this.editor?.chain().focus().toggleBold().run()],
      ["I", () => this.editor?.chain().focus().toggleItalic().run()],
      ["H1", () => this.editor?.chain().focus().toggleHeading({ level: 1 }).run()],
      ["H2", () => this.editor?.chain().focus().toggleHeading({ level: 2 }).run()],
      ["List", () => this.editor?.chain().focus().toggleBulletList().run()],
      ["Task", () => this.editor?.chain().focus().toggleTaskList().run()],
      ["Save", () => void this.persist()],
    ];
    for (const [label, action] of buttons) {
      const button = toolbar.createEl("button", { text: label, cls: "pageden-live-button" });
      button.addEventListener("click", action);
    }
  }

  private seedInitialContent(markdown: string): void {
    if (!this.editor || this.editor.getText().trim()) return;
    this.editor.commands.setContent(markdownToHtml(markdown), { emitUpdate: true });
  }

  private scheduleSave(): void {
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.persist(), 1500);
  }

  private async persist(): Promise<void> {
    if (!this.editor || !this.documentId) return;
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const content = htmlToMarkdown(this.editor.getHTML());
    if (content === this.lastSavedMarkdown) return;
    this.saving = true;
    this.setStatus("Saving");
    try {
      const result = await this.plugin.api().push(this.documentId, {
        baseVersion: this.baseVersion,
        checksum: await checksum(content),
        content,
      });
      this.baseVersion = result.version;
      this.lastSavedMarkdown = content;
      this.setStatus("Saved");
    } catch (error) {
      if (error instanceof PagedenApiError && error.status === 409 && error.currentVersion) {
        this.baseVersion = error.currentVersion;
        this.saving = false;
        await this.persist();
        return;
      }
      this.setStatus("Save failed");
      throw error;
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.scheduleSave();
      }
    }
  }

  private setStatus(status: string): void {
    this.statusEl?.setText(status);
  }

  private destroyLiveSession(): void {
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.editor?.destroy();
    this.provider?.destroy();
    this.ydoc?.destroy();
    this.editor = undefined;
    this.provider = undefined;
    this.ydoc = undefined;
    this.saveAgain = false;
  }
}

class PagedenSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PagedenPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Pageden",
        render: (setting) => {
          setting.settingEl.empty();
          this.renderSettings(setting.settingEl);
        },
      },
    ];
  }

  private renderSettings(containerEl: HTMLElement): void {
    containerEl.empty();
    new Setting(containerEl).setName("Pageden").setHeading();

    const isConnected = this.plugin.isConfigured();

    if (!isConnected) {
      containerEl.createEl("p", {
        text: "Connect your Obsidian vault to Pageden to sync notes and collaborate with your team.",
        cls: "setting-item-description",
      });

      new Setting(containerEl)
        .setName("Connect your vault")
        .setDesc("Click the button below. A login page will open in your browser — approve it there and you're done.")
        .addButton((btn) =>
          btn
            .setButtonText("Connect to Pageden")
            .setCta()
            .onClick(() => void this.plugin.startDeviceLogin()),
        );

      new Setting(containerEl).setName("Server").setHeading();

      new Setting(containerEl)
        .setName("Server URL")
        .setDesc("The address of your Pageden server.")
        .addText((text) =>
          text
            .setPlaceholder("https://app.example.com")
            .setValue(this.plugin.settings.serverUrl)
            .onChange(async (value) => {
              this.plugin.settings.serverUrl = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    } else {
      const displayName = this.plugin.settings.userName || "your account";
      const displayWs = this.plugin.settings.workspaceName || this.plugin.settings.workspaceId;

      new Setting(containerEl)
        .setName(`Signed in as ${displayName}`)
        .setDesc(`Workspace: ${displayWs}`)
        .addButton((btn) =>
          btn.setButtonText("Change workspace").onClick(() => void this.changeWorkspace()),
        )
        .addButton((btn) =>
          btn.setButtonText("Disconnect").onClick(async () => {
            this.plugin.settings.token = "";
            this.plugin.settings.workspaceId = "";
            this.plugin.settings.userName = "";
            this.plugin.settings.workspaceName = "";
            await this.plugin.saveSettings();
            this.plugin.startAutoSync();
            this.update();
          }),
        );

      new Setting(containerEl).setName("Sync").setHeading();

      new Setting(containerEl)
        .setName("Background sync")
        .setDesc("Automatically pull remote updates and push local edits.")
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
            this.plugin.settings.autoSyncEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.startAutoSync();
          }),
        );

      new Setting(containerEl)
        .setName("Sync interval (minutes)")
        .setDesc("How often background sync runs. Minimum 1 minute.")
        .addText((text) =>
          text
            .setPlaceholder("5")
            .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
            .onChange(async (value) => {
              const minutes = Math.max(1, Math.floor(Number(value)) || DEFAULT_SETTINGS.autoSyncIntervalMinutes);
              this.plugin.settings.autoSyncIntervalMinutes = minutes;
              await this.plugin.saveSettings();
              this.plugin.startAutoSync();
            }),
        );

      new Setting(containerEl)
        .setName("Local folder")
        .setDesc("Folder in your vault where downloaded documents are stored.")
        .addText((text) =>
          text
            .setPlaceholder("Remote Docs")
            .setValue(this.plugin.settings.remoteDocsFolder)
            .onChange(async (value) => {
              this.plugin.settings.remoteDocsFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.remoteDocsFolder);
              await this.plugin.saveSettings();
            }),
        );

      const details = containerEl.createEl("details");
      details.createEl("summary", { text: "Advanced" });
      const adv = details.createDiv();

      new Setting(adv)
        .setName("Server URL")
        .addText((text) =>
          text
            .setPlaceholder("https://app.example.com")
            .setValue(this.plugin.settings.serverUrl)
            .onChange(async (value) => {
              this.plugin.settings.serverUrl = value.trim();
              await this.plugin.saveSettings();
              this.plugin.startAutoSync();
            }),
        );

      new Setting(adv)
        .setName("Connection")
        .addButton((btn) =>
          btn.setButtonText("Test connection").onClick(() => void this.plugin.validateConnection()),
        )
        .addButton((btn) =>
          btn.setButtonText("Sign in again").onClick(() => void this.plugin.startDeviceLogin()),
        );
    }
  }

  private async changeWorkspace(): Promise<void> {
    try {
      const me = await this.plugin.api().me();
      if (me.workspaces.length === 0) {
        new Notice("No workspaces found on this account.");
        return;
      }
      new WorkspacePickerModal(this.app, this.plugin, me.workspaces, () => this.update()).open();
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }
}

class RemoteDocumentModal extends Modal {
  constructor(
    app: App,
    private readonly tree: RemoteTree,
    private readonly onPick: (doc: RemoteDocument) => void,
    private readonly buttonText = "Download",
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Pageden documents" });
    const visibleDocs = this.tree.documents.filter((doc) => doc.permission !== "viewer" || doc.version);
    if (visibleDocs.length === 0) {
      contentEl.createEl("p", { text: "No remote documents are available." });
      return;
    }
    for (const doc of visibleDocs) {
      new Setting(contentEl)
        .setName(doc.title)
        .setDesc(doc.permission === "viewer" ? `${doc.path} · read only` : doc.path)
        .addButton((button) =>
          button.setButtonText(this.buttonText).onClick(() => {
            this.close();
            this.onPick(doc);
          }),
        );
    }
  }
}

class RemoteSearchModal extends Modal {
  private query = "";
  private resultsEl?: HTMLElement;

  constructor(app: App, private readonly plugin: PagedenPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Search Pageden" });
    new Setting(contentEl)
      .setName("Query")
      .addText((text) =>
        text
          .setPlaceholder("Search remote documents")
          .onChange((value) => {
            this.query = value;
          }),
      )
      .addButton((button) =>
        button.setButtonText("Search").onClick(() => void this.runSearch()),
      );
    this.resultsEl = contentEl.createDiv();
  }

  private async runSearch(): Promise<void> {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    const q = this.query.trim();
    if (!q) {
      this.resultsEl.createEl("p", { text: "Enter a search query." });
      return;
    }
    try {
      const results = await this.plugin.searchRemote(q);
      if (results.length === 0) {
        this.resultsEl.createEl("p", { text: "No results." });
        return;
      }
      for (const result of results) {
        new Setting(this.resultsEl)
          .setName(result.title)
          .setDesc(result.permission === "viewer" ? `${result.path} · read only` : result.path)
          .addButton((button) =>
            button.setButtonText("Download").onClick(() => {
              this.close();
              void this.plugin.downloadSearchResult(result);
            }),
          );
      }
    } catch (error) {
      this.resultsEl.createEl("p", { text: errorMessage(error) });
    }
  }
}

class VaultImportModal extends Modal {
  private targetRootName = "Imported from Obsidian";
  private previewEl?: HTMLElement;
  private statusEl?: HTMLElement;

  constructor(
    app: App,
    private readonly plugin: PagedenPlugin,
    private readonly files: VaultImportFile[],
    private readonly remoteTree: RemoteTree,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Import Obsidian vault" });
    contentEl.createEl("p", {
      text: "Upload this vault's notes into Pageden. Existing remote documents are skipped, never overwritten.",
    });

    new Setting(contentEl)
      .setName("Pageden folder")
      .setDesc("Imported folders and notes will be created under this top-level folder.")
      .addText((text) =>
        text
          .setPlaceholder("Imported from Obsidian")
          .setValue(this.targetRootName)
          .onChange((value) => {
            this.targetRootName = value.trim() || "Imported from Obsidian";
            this.renderPreview();
          }),
      );

    this.previewEl = contentEl.createDiv();
    this.statusEl = contentEl.createEl("p");
    this.renderPreview();

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Import vault")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Importing...");
            await this.runImport();
            button.setDisabled(false).setButtonText("Import vault");
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  private renderPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    const preview = buildVaultImportPreview(this.files, this.remoteTree, this.targetRootName);
    this.previewEl.createEl("h3", { text: "Preview" });
    const list = this.previewEl.createEl("ul");
    list.createEl("li", { text: `${preview.notes} Markdown note${preview.notes === 1 ? "" : "s"} ready to import.` });
    list.createEl("li", { text: `${preview.attachments} attachment${preview.attachments === 1 ? "" : "s"} detected.` });
    list.createEl("li", { text: `${preview.skipped} internal or unsupported file${preview.skipped === 1 ? "" : "s"} skipped.` });
    if (preview.conflicts.length) {
      list.createEl("li", { text: `${preview.conflicts.length} remote document${preview.conflicts.length === 1 ? "" : "s"} already exist and will be skipped.` });
    }
    this.statusEl?.setText("");
  }

  private async runImport(): Promise<void> {
    try {
      this.statusEl?.setText("Starting import…");
      const report = await this.plugin.importVault(this.files, this.targetRootName, (current, total) => {
        this.statusEl?.setText(`Importing note ${current} of ${total}…`);
      });
      const warnings = report.attachmentWarnings.length ? ` ${report.attachmentWarnings.length} attachment warning${report.attachmentWarnings.length === 1 ? "" : "s"}.` : "";
      this.statusEl?.setText(
        `Done! Created ${report.foldersCreated} folder${report.foldersCreated === 1 ? "" : "s"}, imported ${report.documentsCreated} note${report.documentsCreated === 1 ? "" : "s"}, uploaded ${report.attachmentsUploaded} attachment${report.attachmentsUploaded === 1 ? "" : "s"}.${warnings}`,
      );
      new Notice("Vault import complete.");
    } catch (error) {
      const message = errorMessage(error);
      this.statusEl?.setText(message);
      new Notice(message);
    }
  }
}

class DeviceLoginModal extends Modal {
  private intervalId?: number;
  private statusEl?: HTMLElement;

  constructor(
    app: App,
    private readonly plugin: PagedenPlugin,
    private readonly request: DeviceStartResponse,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect to Pageden" });
    contentEl.createEl("p", {
      text: "A login page should have opened in your browser. Enter this code there to approve the connection:",
    });
    contentEl.createEl("h3", { text: this.request.userCode, cls: "pageden-device-code" });
    contentEl.createEl("p", {
      text: "If the browser did not open automatically, use the button below.",
      cls: "setting-item-description",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Open browser").onClick(() => activeWindow.open(this.request.verificationUri)),
      )
      .addButton((button) =>
        button.setButtonText("Check now").onClick(() => void this.poll()),
      );
    this.statusEl = contentEl.createEl("p", { text: "Waiting for you to approve in the browser…" });
    const intervalMs = Math.max(1, this.request.interval) * 1000;
    this.intervalId = window.setInterval(() => void this.poll(), intervalMs);
    activeWindow.open(this.request.verificationUri);
  }

  onClose(): void {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      const status = await this.plugin.pollDeviceLogin(this.request.deviceCode);
      if (status === "pending") {
        this.statusEl?.setText("Waiting for approval...");
      } else {
        this.close();
      }
    } catch (error) {
      this.statusEl?.setText(errorMessage(error));
    }
  }
}

class WorkspacePickerModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: PagedenPlugin,
    private readonly workspaces: MeResponse["workspaces"],
    private readonly onSelect?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Choose a workspace" });
    contentEl.createEl("p", {
      text: "Select which Pageden workspace to sync with this vault.",
      cls: "setting-item-description",
    });
    for (const ws of this.workspaces) {
      new Setting(contentEl)
        .setName(ws.name)
        .setDesc(ws.role === "admin" ? "You are an admin" : "Member")
        .addButton((btn) =>
          btn
            .setButtonText("Select")
            .setCta()
            .onClick(async () => {
              this.plugin.settings.workspaceId = ws.id;
              this.plugin.settings.workspaceName = ws.name;
              await this.plugin.saveSettings();
              this.plugin.startAutoSync();
              this.close();
              new Notice(`Workspace set to "${ws.name}".`);
              this.onSelect?.();
            }),
        );
    }
  }
}

class FolderDownloadModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: PagedenPlugin,
    private readonly tree: RemoteTree,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Download a folder" });
    contentEl.createEl("p", {
      text: "Choose a folder to download all its notes to your vault.",
      cls: "setting-item-description",
    });

    const foldersWithDocs = this.tree.folders
      .map((folder) => ({ folder, count: this.tree.documents.filter((d) => d.folderId === folder.id).length }))
      .filter(({ count }) => count > 0)
      .sort((a, b) => a.folder.path.localeCompare(b.folder.path));

    if (foldersWithDocs.length === 0) {
      contentEl.createEl("p", { text: "No folders with documents found in your workspace." });
      return;
    }

    for (const { folder, count } of foldersWithDocs) {
      new Setting(contentEl)
        .setName(folder.name)
        .setDesc(`${folder.path} · ${count} note${count === 1 ? "" : "s"}`)
        .addButton((btn) =>
          btn.setButtonText("Download all").onClick(() => {
            this.close();
            void this.plugin.downloadFolderDocuments(folder.id, folder.name, this.tree);
          }),
        );
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Pageden request failed.";
}

function isUnderRemoteDocsFolder(remoteDocsFolder: string, path: string): boolean {
  const root = normalizePath(remoteDocsFolder).replace(/\/+$/, "");
  const localPath = normalizePath(path);
  return localPath === root || localPath.startsWith(`${root}/`);
}

function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

function htmlToMarkdown(html: string): string {
  const markdown = turndown.turndown(html).trimEnd();
  return markdown ? `${markdown}\n` : "";
}
