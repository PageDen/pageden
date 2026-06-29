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
// Minimal Sentry error reporter (zero-dependency)
//
// The shim ships as a single standalone file with no node_modules, so we
// cannot use @sentry/node. Instead we POST events directly to Sentry's
// envelope ingestion endpoint using the global fetch already used by the
// shim. It is strictly fire-and-forget: reporting never throws and NEVER
// writes to stdout (that is the JSON-RPC channel). Set SENTRY_DSN to enable;
// when unset, every capture call is a no-op.
// ---------------------------------------------------------------------------

const SHIM_VERSION = "0.2.1";
const SENTRY_DSN = process.env.SENTRY_DSN ?? "";
const SENTRY_RELEASE = process.env.SENTRY_RELEASE ?? "";
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || "production";

const sentryTarget = ((): { url: string; publicKey: string } | null => {
  if (!SENTRY_DSN) return null;
  try {
    const u = new URL(SENTRY_DSN);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!publicKey || !projectId) return null;
    return { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, publicKey };
  } catch {
    return null;
  }
})();

// 32-char hex Sentry event id. Not security-sensitive (just an event
// identifier), so a plain random hex avoids a node:crypto import that would
// flip tsc output into ESM/CJS-ambiguous code for this single-file binary.
function genEventId(): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function parseStackFrames(stack: string | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    frames.push({
      function: m[1] || "<anonymous>",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: true,
    });
  }
  // Sentry expects frames oldest-call-first (reverse of V8 stack order).
  return frames.reverse();
}

function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentryTarget) return;
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
    const eventId = genEventId();
    const timestamp = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp,
      platform: "node",
      level: "error",
      logger: "pageden-agent-shim",
      ...(SENTRY_RELEASE ? { release: SENTRY_RELEASE } : {}),
      environment: SENTRY_ENVIRONMENT,
      tags: { component: "agent-shim", external_provider: externalProvider },
      ...(context ? { extra: context } : {}),
      exception: {
        values: [
          {
            type: e.name,
            value: e.message,
            stacktrace: { frames: parseStackFrames(e.stack) },
          },
        ],
      },
    };
    const body =
      `${JSON.stringify({ event_id: eventId, sent_at: timestamp, dsn: SENTRY_DSN })}\n` +
      `${JSON.stringify({ type: "event" })}\n` +
      `${JSON.stringify(event)}\n`;
    void fetch(sentryTarget.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=pageden-agent-shim/${SHIM_VERSION}, sentry_key=${sentryTarget.publicKey}`,
      },
      body,
    }).catch(() => {});
  } catch {
    // Reporting must never destabilize the shim.
  }
}

// Surface otherwise-silent fatal errors. Capture, give the async report a
// brief window to flush, then exit so Hermes can respawn a clean process.
process.on("uncaughtException", (err) => {
  captureException(err, { kind: "uncaughtException" });
  setTimeout(() => process.exit(1), 2000);
});
process.on("unhandledRejection", (reason) => {
  captureException(reason, { kind: "unhandledRejection" });
});

process.stderr.write(`pageden-agent-shim ${SHIM_VERSION}: Sentry ${sentryTarget ? "enabled" : "disabled"}\n`);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
  {
    name: "pageden_read_attachment",
    description:
      "Download an attachment from a PageDen document by attachment ID. " +
      "For images, returns the image so you can visually describe its contents. " +
      "For other files (PDF, DOCX, etc.), returns base64-encoded bytes and metadata. " +
      "Use attachment IDs returned by pageden_read_document.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
        attachmentId: { type: "string", description: "The attachment ID to download." },
      },
      required: ["externalAccountId", "attachmentId"],
    },
  },
  {
    name: "pageden_list_workspaces",
    description:
      "List all PageDen workspaces the calling user belongs to. Use this to discover workspace names and IDs before calling workspace-scoped tools.",
    inputSchema: {
      type: "object",
      properties: {
        externalAccountId: {
          type: "string",
          description: `The calling user's account ID on this platform (e.g. ${externalProvider} user ID).`,
        },
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

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

// undici (global fetch) throws TypeError("fetch failed") for DNS/connection/
// socket-level failures and Abort/Timeout errors when a request is aborted.
// These are worth retrying; an HTTP response (even 5xx) is not a throw.
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

// Unwrap undici's generic "fetch failed" to the underlying cause (ENOTFOUND,
// ECONNREFUSED, ECONNRESET, timeout, ...) so Sentry shows the real reason.
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return `${err.message} (${code ? `${code}: ` : ""}${cause.message})`;
  }
  return cause ? `${err.message} (${String(cause)})` : err.message;
}

async function callAction(path: string, payload: Record<string, unknown>): Promise<ActionResponse> {
  const url = `${baseUrl}${path}`;
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify(payload),
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientNetworkError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      break;
    }
  }

  // Persistent failure: throw a descriptive error (with the underlying cause)
  // so the tools/call handler reports it to Sentry and the caller with context
  // instead of a bare "fetch failed".
  throw new Error(
    `PageDen request to ${path} failed after ${MAX_ATTEMPTS} attempt(s): ${describeFetchError(lastErr)}`,
  );
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function runTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<McpContent> }> {
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

  if (name === "pageden_read_attachment") {
    const attachmentId = args["attachmentId"] ? String(args["attachmentId"]) : undefined;
    if (!attachmentId) return text("attachmentId is required.");

    const result = await callAction("/api/integrations/actions/attachment-read", {
      externalProvider,
      externalAccountId,
      attachmentId,
    });

    if (result.status === 403 && (result.body as Record<string, unknown>)["error"] === "account_not_linked") {
      const connectUrl = String((result.body as Record<string, unknown>)["connectUrl"] ?? "");
      return text(
        `Your ${externalProvider} account is not linked to PageDen yet.\n` +
          (connectUrl ? `Connect your account here: ${connectUrl}` : "Please contact your workspace admin to get a link."),
      );
    }

    if (!result.ok) {
      const message = String((result.body as Record<string, unknown>)["message"] ?? `Request failed with status ${result.status}`);
      return text(`PageDen error: ${message}`);
    }

    const attachment = (result.body as Record<string, unknown>)["attachment"] as Record<string, unknown>;
    const contentType = String(attachment["contentType"] ?? "");
    const contentBase64 = String(attachment["contentBase64"] ?? "");
    const filename = String(attachment["filename"] ?? "attachment");
    const size = Number(attachment["size"] ?? 0);

    const isImage = contentType.startsWith("image/");
    if (isImage) {
      return {
        content: [
          { type: "text", text: `Attachment: ${filename} (${contentType}, ${size} bytes)` },
          { type: "image", data: contentBase64, mimeType: contentType },
        ],
      };
    }

    // Non-image: return metadata + base64 as text
    return text(
      JSON.stringify({ filename, contentType, size, contentBase64 }, null, 2),
    );
  }

  if (name === "pageden_list_workspaces") {
    const result = await callAction("/api/integrations/actions/list-workspaces", {
      externalProvider,
      externalAccountId,
    });
    return formatActionResult(result);
  }

  return text(`Unknown tool: ${name}`);
}

function formatActionResult(result: ActionResponse): { content: Array<McpContent> } {
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
    // Client errors (401/403/404/4xx) are expected operational responses; only
    // report server-side failures (5xx) to Sentry as actionable problems.
    if (result.status >= 500) {
      captureException(new Error(`PageDen API ${result.status}: ${message}`), { status: result.status });
    }
    return text(`PageDen error: ${message}`);
  }

  return text(JSON.stringify(result.body, null, 2));
}

function text(message: string): { content: Array<McpContent> } {
  return { content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// MCP stdio framing (JSON-RPC 2.0 over newline-delimited JSON)
//
// The MCP stdio transport frames each JSON-RPC message as a single line of
// JSON terminated by "\n" (NOT LSP-style Content-Length headers). The Python
// MCP SDK used by Hermes speaks this newline-delimited framing, so the shim
// must read and write the same way or the client's initialize() never gets a
// response and times out (CancelledError).
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
        serverInfo: { name: "pageden-agent-shim", version: SHIM_VERSION },
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
        captureException(err, { tool: name });
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
