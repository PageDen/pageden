# @pageden/obsidian-plugin

Obsidian integration for Pageden.

## Commands

- `Pageden: Validate connection`
- `Pageden: Browse remote documents`
- `Pageden: Search remote documents`
- `Pageden: Open live document`
- `Pageden: Push active document`
- `Pageden: Log in with device code`

## Settings

- Server URL, for example `https://app.example.com`
- Personal access token from the web app's Obsidian token screen, or a token from device-code login
- Workspace ID
- Local folder, default `Remote Docs`

Downloaded files are written under the local folder. Sync metadata is stored in
`.server-meta.json` next to the plugin files and is keyed by `documentId`.

Pushes send the recorded `baseVersion`, LF-canonicalized content, and checksum. On `409`
the local file is left untouched and the server copy is written as `*.conflict.md`.

Remote search uses the server's permission-filtered `GET /search` endpoint and can download a
matching document into the configured local folder.

Live document mode opens a custom Pageden editor pane inside Obsidian instead of editing a
downloaded Markdown file. It joins the same Yjs/WebSocket room as the web app's Live mode, merges
simultaneous edits, and autosaves the merged Markdown through the normal revision API. Use this
when you want Google Docs-style co-editing; use downloaded files + background sync when you want
the native Obsidian vault/file workflow.

Attachment sync follows Markdown links such as `![diagram](diagram.png)` and Obsidian embeds
such as `![[diagram.png]]`. Downloading or pulling a document writes server attachments beside
the local Markdown file. Pushing a document uploads changed referenced local attachments and
deletes remote attachments only when a previously tracked local attachment file was removed.

## Manual E2E

Build and install into a disposable vault:

```bash
pnpm --filter @pageden/obsidian-plugin build
OBSIDIAN_VAULT=/tmp/pageden-e2e-vault pnpm --filter @pageden/obsidian-plugin install:vault
```

