#!/usr/bin/env node

const baseUrl = (process.env.PAGEDEN_URL ?? "").replace(/\/+$/, "");
const clientId = process.env.PAGEDEN_CLIENT_ID ?? "";
const clientSecret = process.env.PAGEDEN_CLIENT_SECRET ?? "";
const externalProvider = process.env.PAGEDEN_EXTERNAL_PROVIDER || "discord";

if (!baseUrl || !clientId || !clientSecret) {
  process.stderr.write(
    [
      "PageDen agent shim is missing configuration.",
      "Required: PAGEDEN_URL, PAGEDEN_CLIENT_ID, PAGEDEN_CLIENT_SECRET",
      "Optional: PAGEDEN_EXTERNAL_PROVIDER (default: discord)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "pageden_read_document",
    description:
      "Read a PageDen document. Without externalAccountId, reads any canonical document within the workspace's allowed folders (no login required). With externalAccountId, reads any document the user has access to.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `Optional. The calling user's account ID on this platform (e.g. ${externalProvider} user ID). Required to read non-canonical documents or documents outside the configured allowed folders.`,
        },
        documentId: { type: "string", description: "PageDen document ID." },
        path: {
          type: "string",
          description: 'PageDen document path (e.g. "/projects/roadmap"). Use when documentId is unknown.',
        },
      },
      required: [],
    },
  },
  {
    name: "pageden_search_documents",
    description:
      "Full-text search across PageDen documents. Without externalAccountId, searches canonical documents within the workspace's allowed folders. With externalAccountId, searches all documents the user has access to.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `Optional. The calling user's account ID on this platform (e.g. ${externalProvider} user ID). Required to search documents outside the configured allowed folders.`,
        },
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum results to return (1–50, default 10)." },
        canonicalOnly: {
          type: "boolean",
          description: "When true, only return documents in canonical status. Default true when no externalAccountId is provided.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "pageden_create_document",
    description:
      "Create a new PageDen document. Requires the calling user to be linked to PageDen and have editor access to the destination folder.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID). Must be linked to a PageDen account.`,
        },
        path: {
          type: "string",
          description:
            'Desired document path, without .md extension (e.g. "/handbook/notes/my-note"). The folder must already exist. Slug must be lowercase letters, numbers, and hyphens.',
        },
        title: { type: "string", description: "Document title." },
        content: { type: "string", description: "Optional initial Markdown content." },
      },
      required: ["externalAccountId", "path", "title"],
    },
  },
  {
    name: "pageden_append_to_document",
    description:
      "Append Markdown content to the end of an existing PageDen document. Requires the calling user to have editor access.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        documentId: { type: "string", description: "PageDen document ID." },
        path: { type: "string", description: "Document path. Used when documentId is unknown." },
        content: { type: "string", description: "Markdown content to append." },
      },
      required: ["externalAccountId", "content"],
    },
  },
  {
    name: "pageden_update_document",
    description:
      "Replace the content (and optionally the title) of an existing PageDen document. Requires editor access. To make a targeted edit, first read the document, modify the content, then call this tool.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        documentId: { type: "string", description: "PageDen document ID." },
        path: { type: "string", description: "Document path. Used when documentId is unknown." },
        content: { type: "string", description: "New full Markdown content. If omitted, only the title is updated." },
        title: { type: "string", description: "New document title. Optional." },
      },
      required: ["externalAccountId"],
    },
  },
  {
    name: "pageden_attach_file",
    description:
      "Download a file from a URL and attach it to a PageDen document. Requires editor access to the document.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        documentId: { type: "string", description: "PageDen document ID." },
        path: { type: "string", description: "Document path. Used when documentId is unknown." },
        fileUrl: { type: "string", description: "Public URL of the file to attach. Use this when you have a URL." },
        filePath: { type: "string", description: "Local filesystem path of the file to attach. Use this when the file is available locally (e.g. a cached Discord attachment)." },
        filename: { type: "string", description: "Optional filename override. Defaults to the last path segment of fileUrl or filePath." },
      },
      required: ["externalAccountId"],
    },
  },
];

// ---------------------------------------------------------------------------
// PageDen REST client
// ---------------------------------------------------------------------------

interface ActionResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function callAction(path: string, payload: Record<string, unknown>): Promise<ActionResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function runTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (name === "pageden_read_document") {
    const externalAccountId = args["externalAccountId"] ? String(args["externalAccountId"]) : undefined;
    const documentId = args["documentId"] ? String(args["documentId"]) : undefined;
    const path = args["path"] ? String(args["path"]) : undefined;
    if (!documentId && !path) return text("Provide documentId or path.");

    const result = await callAction("/api/integrations/actions/document-read", {
      ...(externalAccountId ? { externalProvider, externalAccountId } : {}),
      ...(documentId ? { documentId } : { path }),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_search_documents") {
    const externalAccountId = args["externalAccountId"] ? String(args["externalAccountId"]) : undefined;
    const query = String(args["query"] ?? "");
    if (!query) return text("query is required.");

    const result = await callAction("/api/integrations/actions/document-search", {
      ...(externalAccountId ? { externalProvider, externalAccountId } : {}),
      query,
      ...(args["limit"] !== undefined ? { limit: Number(args["limit"]) } : {}),
      ...(args["canonicalOnly"] !== undefined ? { canonicalOnly: Boolean(args["canonicalOnly"]) } : {}),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_create_document") {
    const externalAccountId = String(args["externalAccountId"] ?? "");
    if (!externalAccountId) return text("externalAccountId is required to create documents.");
    const path = String(args["path"] ?? "");
    const title = String(args["title"] ?? "");
    if (!path) return text("path is required.");
    if (!title) return text("title is required.");

    const result = await callAction("/api/integrations/actions/document-create", {
      externalProvider,
      externalAccountId,
      path,
      title,
      ...(args["content"] !== undefined ? { content: String(args["content"]) } : {}),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_append_to_document") {
    const externalAccountId = String(args["externalAccountId"] ?? "");
    if (!externalAccountId) return text("externalAccountId is required.");
    const documentId = args["documentId"] ? String(args["documentId"]) : undefined;
    const path = args["path"] ? String(args["path"]) : undefined;
    const content = String(args["content"] ?? "");
    if (!documentId && !path) return text("Provide documentId or path.");
    if (!content) return text("content is required.");

    const result = await callAction("/api/integrations/actions/document-append", {
      externalProvider,
      externalAccountId,
      content,
      ...(documentId ? { documentId } : { path }),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_update_document") {
    const externalAccountId = String(args["externalAccountId"] ?? "");
    if (!externalAccountId) return text("externalAccountId is required.");
    const documentId = args["documentId"] ? String(args["documentId"]) : undefined;
    const path = args["path"] ? String(args["path"]) : undefined;
    if (!documentId && !path) return text("Provide documentId or path.");
    if (args["content"] === undefined && !args["title"]) return text("Provide content or title to update.");

    const result = await callAction("/api/integrations/actions/document-update", {
      externalProvider,
      externalAccountId,
      ...(documentId ? { documentId } : { path }),
      ...(args["content"] !== undefined ? { content: String(args["content"]) } : {}),
      ...(args["title"] ? { title: String(args["title"]) } : {}),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_attach_file") {
    const externalAccountId = String(args["externalAccountId"] ?? "");
    if (!externalAccountId) return text("externalAccountId is required.");
    const documentId = args["documentId"] ? String(args["documentId"]) : undefined;
    const docPath = args["path"] ? String(args["path"]) : undefined;
    const fileUrl = args["fileUrl"] ? String(args["fileUrl"]) : undefined;
    const filePath = args["filePath"] ? String(args["filePath"]) : undefined;
    if (!documentId && !docPath) return text("Provide documentId or path.");
    if (!fileUrl && !filePath) return text("Provide fileUrl or filePath.");

    let payload: Record<string, unknown> = {
      externalProvider,
      externalAccountId,
      ...(documentId ? { documentId } : { path: docPath }),
    };

    if (filePath) {
      let fileBytes: Buffer;
      try {
        const { readFileSync } = await import("node:fs");
        fileBytes = Buffer.from(readFileSync(filePath));
      } catch {
        return text(`Could not read file at path: ${filePath}`);
      }
      const { basename } = await import("node:path");
      const filename = args["filename"] ? String(args["filename"]) : basename(filePath);
      payload = { ...payload, fileContent: fileBytes.toString("base64"), filename };
    } else {
      payload = {
        ...payload,
        fileUrl,
        ...(args["filename"] ? { filename: String(args["filename"]) } : {}),
      };
    }

    const result = await callAction("/api/integrations/actions/file-attach", payload);
    return formatActionResult(result);
  }

  return text(`Unknown tool: ${name}`);
}

function formatActionResult(result: ActionResponse): { content: Array<{ type: "text"; text: string }> } {
  const body = result.body as Record<string, unknown>;

  if (result.status === 403 && body["error"] === "account_not_linked") {
    const connectUrl = String(body["connectUrl"] ?? "");
    return text(
      `Your ${externalProvider} account is not linked to PageDen yet.\n` +
        (connectUrl ? `Connect your account here: ${connectUrl}` : "Please contact your workspace admin to get a link."),
    );
  }

  if (!result.ok) {
    const message = String(body["message"] ?? `Request failed with status ${result.status}`);
    return text(`PageDen error: ${message}`);
  }

  return text(JSON.stringify(result.body, null, 2));
}

function text(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// MCP stdio framing (JSON-RPC 2.0 over newline-delimited JSON)
// Compatible with Python MCP SDK v1.x (mcp>=1.0) used by Hermes.
// ---------------------------------------------------------------------------

type JsonRpcRequest = { id: string | number; method: string; params?: unknown };
type JsonRpcNotification = { method: string; params?: unknown };

let lineBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  lineBuffer += chunk;
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) void handle(trimmed);
  }
});

async function handle(raw: string): Promise<void> {
  let msg: JsonRpcRequest | JsonRpcNotification;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest | JsonRpcNotification;
  } catch {
    return;
  }

  // Notifications (no id) — no response required
  if (!("id" in msg)) return;

  const req = msg as JsonRpcRequest;
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (req.method) {
    case "initialize":
      respond(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pageden-agent-shim", version: "0.2.0" },
      });
      break;

    case "tools/list":
      respond(req.id, { tools: TOOLS });
      break;

    case "tools/call": {
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      try {
        const result = await runTool(name, args);
        respond(req.id, result);
      } catch (err) {
        respondError(req.id, -32603, err instanceof Error ? err.message : "Internal error");
      }
      break;
    }

    default:
      respondError(req.id, -32601, "Method not found");
  }
}

function respond(id: string | number, result: unknown): void {
  writeFrame(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function respondError(id: string | number, code: number, message: string): void {
  writeFrame(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function writeFrame(body: string): void {
  process.stdout.write(body + "\n");
}
