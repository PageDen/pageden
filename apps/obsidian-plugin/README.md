# Pageden for Obsidian

Connect an Obsidian vault to Pageden, a server-owned Markdown workspace for teams and AI agents.
Use it to browse remote documents, download folders into your vault, sync local edits back to
Pageden, and import an existing vault into a workspace.

## Requirements

- Obsidian 1.5.0 or newer.
- A Pageden workspace. The hosted server defaults to `https://go.pageden.app`.
- Network access to your Pageden server.

## Commands

- `Pageden: Validate connection`
- `Pageden: Browse remote documents`
- `Pageden: Search remote documents`
- `Pageden: Open live document`
- `Pageden: Push active document`
- `Pageden: Sync now`
- `Pageden: Download a Pageden folder`
- `Pageden: Download all Pageden documents`
- `Pageden: Import this vault to Pageden`
- `Pageden: Resolve conflict for this note`
- `Pageden: Log in with device code`

## Setup

1. Open Obsidian settings.
2. Go to **Community plugins** and enable Pageden.
3. Open **Pageden** settings.
4. Keep the default server URL, or enter your self-hosted Pageden server.
5. Click **Connect to Pageden** and approve the login in your browser.
6. Pick the workspace to sync with this vault.

## Using Pageden In Obsidian

After setup, Pageden adds commands to Obsidian's command palette. Open the command palette with
`Ctrl+P` or `Cmd+P`, type `Pageden`, then choose the action you need.

### Bring an existing vault into Pageden

Use this when your notes already live in Obsidian and you want to publish them into a Pageden
workspace.

1. Open the command palette.
2. Run **Pageden: Import this vault to Pageden**.
3. Choose the Pageden folder name for the imported notes. The default is `Imported from Obsidian`.
4. Review the import preview.
5. Click **Import vault**.

The import creates folders and documents in Pageden. Existing remote documents with the same path
are skipped rather than overwritten. Referenced local attachments are uploaded when the vault
adapter supports binary reads.

### Download Pageden documents into Obsidian

Use this when the source documents already exist in Pageden and you want local Markdown copies in
your vault.

1. Run **Pageden: Browse remote documents** to pick one document, or run
   **Pageden: Download a Pageden folder** to download every document in a folder.
2. The plugin writes downloaded files under the configured local folder. The default is
   `Remote Docs`.
3. Edit the downloaded Markdown files normally in Obsidian.

You can also run **Pageden: Download all Pageden documents** to create local copies of every
document your account can access.

### Edit and sync documents

Downloaded Pageden documents are normal Markdown files. Edit them in Obsidian, then let background
sync send the changes back to Pageden.

- Keep **Background sync** enabled for automatic pull and push.
- Run **Pageden: Sync now** when you want to sync immediately.
- Run **Pageden: Push active document** when you want to push only the note you are currently
  editing.

The Obsidian status bar shows the current sync state, such as `Pageden: synced`, `Pageden: up to
date`, or `Pageden: conflict`.

### Create a new Pageden document from Obsidian

To create a new document from Obsidian:

1. Create a Markdown note inside the configured local folder, for example
   `Remote Docs/team/plan.md`.
2. Write the note in Obsidian.
3. Run **Pageden: Push active document**, or wait for background sync.

The plugin creates any missing remote folders, creates the document in Pageden, and records sync
metadata so later edits use the normal conflict checks.

### Search and download from Pageden

Use **Pageden: Search remote documents** when you know what you need but do not know where it lives
in the workspace.

1. Run **Pageden: Search remote documents**.
2. Enter a search term.
3. Pick a result and click **Download**.

Search only returns documents your Pageden account is allowed to read.

### Use live document mode

Use **Pageden: Open live document** when you want to edit the same document as the web app in a live
collaboration session.

Live mode opens a Pageden editor pane in Obsidian instead of editing a local Markdown file. Use it
for co-editing with other people. Use downloaded files plus background sync when you prefer the
normal Obsidian file workflow.

### Work with attachments

When a Markdown note references local files, the plugin can sync those attachments with Pageden.
For example:

```markdown
![diagram](diagram.png)
![[diagram.png]]
```

When you push a note, changed referenced attachments are uploaded. When you download or pull a
document, server attachments are written beside the local Markdown file.

### Resolve conflicts

A conflict can happen when the local note and the Pageden document both changed since the last
sync. The plugin keeps your local file untouched and writes the server copy as a sibling file named
`*.conflict.md`.

To resolve it:

1. Compare your local note with the `*.conflict.md` file.
2. Manually copy over the content you want to keep.
3. Delete the conflict file by running **Pageden: Resolve conflict for this note**.
4. Run **Pageden: Push active document** or **Pageden: Sync now**.

## Settings Reference

- Server URL, default `https://go.pageden.app`
- Personal access token from the web app's Obsidian token screen, or a token from device-code login
- Workspace ID
- Local folder, default `Remote Docs`
- Background sync toggle
- Sync interval in minutes

Downloaded files are written under the local folder. Sync metadata is stored in
`.server-meta.json` next to the plugin files and is keyed by `documentId`.

## Sync Behavior

Pushes send the recorded `baseVersion`, LF-canonicalized content, and checksum. On a conflict,
the local file is left untouched and the server copy is written as `*.conflict.md`.

New local Markdown notes can also be created in Pageden. Put the note inside the configured
local folder, for example `Remote Docs/team/plan.md`, then run `Pageden: Push active document`.
The plugin creates any missing remote folders, creates the document, and records sync metadata
so later edits use normal push/pull conflict checks. Background sync also auto-creates new
unlinked notes that are saved under the configured local folder.

Remote search uses the server's permission-filtered `GET /search` endpoint and can download a
matching document into the configured local folder.

## Live Documents

Live document mode opens a custom Pageden editor pane inside Obsidian instead of editing a
downloaded Markdown file. It joins the same Yjs/WebSocket room as the web app's Live mode, merges
simultaneous edits, and autosaves the merged Markdown through the normal revision API. Use this
when you want Google Docs-style co-editing; use downloaded files + background sync when you want
the native Obsidian vault/file workflow.

## Attachments

Attachment sync follows Markdown links such as `![diagram](diagram.png)` and Obsidian embeds
such as `![[diagram.png]]`. Downloading or pulling a document writes server attachments beside
the local Markdown file. Pushing a document uploads changed referenced local attachments and
deletes remote attachments only when a previously tracked local attachment file was removed.

## Privacy And Network Access

Pageden for Obsidian communicates with the Pageden server configured in settings. Document
content, metadata, attachment files, and sync state are sent to that server when you download,
push, import, or use live editing. The plugin does not send data to unrelated third-party
services.

## Release Checklist

Obsidian community releases must publish these files as individual GitHub release assets:

- `main.js`
- `manifest.json`
- `styles.css`

The GitHub release tag must exactly match the version in `manifest.json`. For example, version
`0.1.0` should use the tag `0.1.0`, not `v0.1.0`.

## Manual E2E

Build and install into a disposable vault:

```bash
pnpm --filter @pageden/obsidian-plugin build
OBSIDIAN_VAULT=/tmp/pageden-e2e-vault pnpm --filter @pageden/obsidian-plugin install:vault
```
