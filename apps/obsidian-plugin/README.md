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
