#!/usr/bin/env node

const baseUrl = (process.env.PAGEDEN_URL ?? "").replace(/\/+$/, "");
const token = process.env.PAGEDEN_TOKEN ?? "";
const workspace = process.env.PAGEDEN_WORKSPACE ?? "";

if (!baseUrl || !token) {
  process.stderr.write(
    [
      "Pageden MCP bridge is missing configuration.",
      "Set PAGEDEN_URL and PAGEDEN_TOKEN. PAGEDEN_WORKSPACE is recommended.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

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
    await forward(body);
  }
}

async function forward(body: string): Promise<void> {
  const url = new URL(`${baseUrl}/mcp`);
  if (workspace) url.searchParams.set("workspaceId", workspace);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body,
  });
  const text = await response.text();
  if (!text) return;
  writeFrame(text);
}

function writeFrame(body: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
