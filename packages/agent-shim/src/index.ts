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
      "Read a PageDen document on behalf of the calling user. Returns the full document content and metadata. Use documentId when known; fall back to path otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        documentId: { type: "string", description: "PageDen document ID." },
        path: {
          type: "string",
          description: 'PageDen document path (e.g. "/projects/roadmap"). Use when documentId is unknown.',
        },
      },
      required: ["externalAccountId"],
    },
  },
  {
    name: "pageden_search_documents",
    description:
      "Full-text search across PageDen documents accessible to the calling user. Returns ranked results with title, path, and a content snippet.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum results to return (1–50, default 10)." },
        canonicalOnly: {
          type: "boolean",
          description: "When true, only return documents in canonical status (excludes drafts and superseded).",
        },
      },
      required: ["externalAccountId", "query"],
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
  const externalAccountId = String(args["externalAccountId"] ?? "");
  if (!externalAccountId) {
    return text("externalAccountId is required.");
  }

  if (name === "pageden_read_document") {
    const documentId = args["documentId"] ? String(args["documentId"]) : undefined;
    const path = args["path"] ? String(args["path"]) : undefined;
    if (!documentId && !path) return text("Provide documentId or path.");

    const result = await callAction("/api/integrations/actions/document-read", {
      externalProvider,
      externalAccountId,
      ...(documentId ? { documentId } : { path }),
    });
    return formatActionResult(result);
  }

  if (name === "pageden_search_documents") {
    const query = String(args["query"] ?? "");
    if (!query) return text("query is required.");

    const result = await callAction("/api/integrations/actions/document-search", {
      externalProvider,
      externalAccountId,
      query,
      ...(args["limit"] !== undefined ? { limit: Number(args["limit"]) } : {}),
      ...(args["canonicalOnly"] !== undefined ? { canonicalOnly: Boolean(args["canonicalOnly"]) } : {}),
    });
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
// MCP stdio framing (JSON-RPC 2.0 over Content-Length frames)
// ---------------------------------------------------------------------------

type JsonRpcRequest = { id: string | number; method: string; params?: unknown };
type JsonRpcNotification = { method: string; params?: unknown };

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  void drain();
});

async function drain(): Promise<void> {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) {
      process.stderr.write("Invalid MCP frame: missing Content-Length\n");
      process.exit(1);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.slice(bodyStart + length);
    await handle(body);
  }
}

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
        serverInfo: { name: "pageden-agent-shim", version: "0.1.0" },
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
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
