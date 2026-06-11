# Connect AI Agents To Pageden

Pageden can be the shared knowledge base for Codex, Claude, Hermes, OpenClaw, and other MCP clients.

## The Easy Path

1. Open your Pageden workspace.
2. Open the workspace menu and choose **AI agents**.
3. Pick the agent you want to connect.
4. Choose the access level:
   - **Read only** for search, summaries, citations, and planning.
   - **Editor** only for trusted agents that can create or update documents.
5. Click **Create agent key**.
6. Copy or download the generated setup.
7. Paste it into your agent app.
8. Use **Test connection** before leaving the page.

The secret token is shown once. If you lose it, revoke the old key and create a new one.

## Codex

Use the **Codex config** block from Pageden. It is a TOML snippet for your Codex MCP settings.

Pageden will fill in:

- `PAGEDEN_URL`
- `PAGEDEN_TOKEN`
- `PAGEDEN_WORKSPACE`

## Claude

Use the **Claude Desktop config** block from Pageden. It is a JSON snippet for Claude Desktop MCP settings.

After pasting it, restart Claude Desktop so it reloads MCP servers.

## Hermes And OpenClaw

Use the **Direct HTTP MCP** block unless the app has a dedicated MCP config format.

The important values are:

- Endpoint: `https://go.pageden.app/mcp` or your staging URL
- Authorization: `Bearer <agent-token>`
- Workspace: the workspace id shown in Pageden

## OAuth MCP Clients

Pageden also exposes OAuth discovery for clients that support MCP OAuth:

- MCP discovery: `/.well-known/pageden-mcp.json`
- OAuth authorization server: `/.well-known/oauth-authorization-server`
- Protected resource metadata: `/.well-known/oauth-protected-resource`

If the client does not support OAuth yet, use the manual agent-key flow above.

## What Agents Can Read

Agents only see documents their Pageden key can access. Read responses include:

- Markdown content
- frontmatter metadata
- headings
- wikilinks
- document path and version

That makes answers easier to cite and safer to update.

## Revoking Access

Open **AI agents** and use **Active agent keys** to revoke keys you no longer use.
