import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { canManageWorkspace } from "../permissions/index.js";
import { writeAuditEvent } from "../audit.js";
import { notFound, validationError } from "../errors.js";
import { writeBlob, readBlob } from "../storage.js";

export const MAX_LOGO_BYTES = 512 * 1024; // 512 KiB

const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

// Read CLOUD_HOSTED at request time (not module load) so tests can toggle it,
// mirroring the cloud approvals gate. Falls back to the boot-time env value.
function cloudHostedEnabled(): boolean {
  const v = process.env.CLOUD_HOSTED;
  if (v === undefined) return env.cloudHosted;
  return v === "true" || v === "1";
}

type LogoFields = { id: string; logoStorageKey: string | null; logoSha: string | null };

/** Versioned public URL for a workspace logo, or null when none is set. */
export function workspaceLogoUrl(ws: LogoFields): string | null {
  return ws.logoStorageKey ? `/api/workspaces/${ws.id}/logo?v=${ws.logoSha ?? ""}` : null;
}

const BLOCKED_SVG_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
]);

const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

function readXmlName(input: string, start: number): { name: string; next: number } {
  let i = start;
  while (i < input.length && /[A-Za-z0-9:_.-]/.test(input[i] ?? "")) i += 1;
  return { name: input.slice(start, i), next: i };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/[&"<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "<":
        return "&lt;";
      default:
        return "&gt;";
    }
  });
}

function safeUrlAttributeValue(value: string): boolean {
  const normalized = Array.from(value)
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127 && !/\s/.test(char))
    .join("")
    .toLowerCase();
  return normalized === "" || normalized.startsWith("#");
}

function sanitizeSvgAttributes(input: string): string {
  const attrs: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] ?? "")) i += 1;
    if (i >= input.length) break;

    const { name, next } = readXmlName(input, i);
    if (!name) break;
    i = next;

    while (i < input.length && /\s/.test(input[i] ?? "")) i += 1;
    if (input[i] !== "=") continue;
    i += 1;
    while (i < input.length && /\s/.test(input[i] ?? "")) i += 1;

    const quote = input[i];
    let value: string;
    if (quote === '"' || quote === "'") {
      i += 1;
      const valueStart = i;
      while (i < input.length && input[i] !== quote) i += 1;
      value = input.slice(valueStart, i);
      if (input[i] === quote) i += 1;
    } else {
      const valueStart = i;
      while (i < input.length && !/\s/.test(input[i] ?? "")) i += 1;
      value = input.slice(valueStart, i);
    }

    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("on")) continue;
    if (lowerName === "style") continue;
    if (URL_ATTRIBUTES.has(lowerName) && !safeUrlAttributeValue(value)) continue;
    attrs.push(`${name}="${escapeAttributeValue(value)}"`);
  }
  return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

/**
 * Best-effort SVG hardening: strip scriptable elements, event-handler
 * attributes, external/scriptable URL attributes, and inline style attributes.
 * Defense-in-depth only — the serve route also sends a restrictive CSP +
 * nosniff so a missed vector still can't execute. Returns the cleaned markup.
 */
export function sanitizeSvg(input: Buffer): Buffer {
  const svg = input.toString("utf8");
  let out = "";
  const blockedStack: string[] = [];
  let cursor = 0;

  while (cursor < svg.length) {
    const tagStart = svg.indexOf("<", cursor);
    if (tagStart === -1) {
      if (blockedStack.length === 0) out += svg.slice(cursor);
      break;
    }
    if (blockedStack.length === 0) out += svg.slice(cursor, tagStart);

    const tagEnd = svg.indexOf(">", tagStart + 1);
    if (tagEnd === -1) break;
    const rawTag = svg.slice(tagStart + 1, tagEnd).trim();
    cursor = tagEnd + 1;

    if (!rawTag || rawTag.startsWith("!") || rawTag.startsWith("?")) continue;

    const closing = rawTag.startsWith("/");
    const nameStart = closing ? 1 : 0;
    const { name, next } = readXmlName(rawTag, nameStart);
    const lowerName = name.toLowerCase();
    if (!name) continue;

    if (closing) {
      if (BLOCKED_SVG_ELEMENTS.has(lowerName)) {
        const lastBlocked = blockedStack[blockedStack.length - 1];
        if (lastBlocked === lowerName) blockedStack.pop();
        continue;
      }
      if (blockedStack.length === 0) out += `</${name}>`;
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    if (BLOCKED_SVG_ELEMENTS.has(lowerName)) {
      if (!selfClosing) blockedStack.push(lowerName);
      continue;
    }
    if (blockedStack.length > 0) continue;

    const attrText = rawTag.slice(next, selfClosing ? -1 : undefined);
    out += `<${name}${sanitizeSvgAttributes(attrText)}${selfClosing ? " /" : ""}>`;
  }

  return Buffer.from(out, "utf8");
}

export async function registerWorkspaceLogoRoutes(app: FastifyInstance): Promise<void> {
  // Public, unauthenticated serve so the pre-auth login/signup pages on a
  // workspace subdomain can render the logo. Logos are public branding.
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/logo", async (request, reply) => {
    const ws = await prisma.workspace.findUnique({
      where: { id: request.params.id },
      select: { logoStorageKey: true, logoContentType: true, logoSha: true },
    });
    if (!ws?.logoStorageKey) return notFound(reply, "Logo not found.");
    const bytes = await readBlob(ws.logoStorageKey);
    return reply
      .header("content-type", ws.logoContentType ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header("etag", `"${ws.logoSha ?? ""}"`)
      .header("cache-control", "public, max-age=300")
      .send(bytes);
  });

  // Upload + delete share a raw-body plugin scope so the buffer parser does not
  // leak onto JSON routes. Cloud-only capability.
  await app.register(async (instance) => {
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    instance.post<{ Params: { id: string } }>(
      "/api/workspaces/:id/logo",
      { bodyLimit: MAX_LOGO_BYTES + 1024 },
      async (request, reply) => {
        if (!cloudHostedEnabled()) return notFound(reply, "Not found.");
        const auth = await requireAuth(request);
        requireTokenScope(auth, "update");
        const workspaceId = request.params.id;
        if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

        const ctHeader = request.headers["content-type"];
        const contentType = (typeof ctHeader === "string" && ctHeader.split(";")[0]?.trim()) || "";
        if (!ALLOWED_LOGO_TYPES.has(contentType)) {
          return validationError(reply, { logo: "Logo must be a PNG, JPG, WebP, or SVG image." });
        }

        const raw = request.body;
        if (!Buffer.isBuffer(raw) || raw.length === 0) {
          return validationError(reply, { logo: "Logo body must be non-empty image content." });
        }
        if (raw.length > MAX_LOGO_BYTES) {
          return reply.code(413).send({ error: "payload_too_large", message: `Logo exceeds ${MAX_LOGO_BYTES} bytes.` });
        }
        const bytes: Buffer = contentType === "image/svg+xml" ? sanitizeSvg(raw) : raw;

        const { storageKey, hex } = await writeBlob(bytes, workspaceId);
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { logoStorageKey: storageKey, logoContentType: contentType, logoSha: hex },
        });
        await writeAuditEvent({
          workspaceId,
          userId: auth.userId,
          action: "workspace_logo_updated",
          targetType: "workspace",
          targetId: workspaceId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { contentType, size: bytes.length },
        });
        return { logoUrl: `/api/workspaces/${workspaceId}/logo?v=${hex}` };
      },
    );

    instance.delete<{ Params: { id: string } }>("/api/workspaces/:id/logo", async (request, reply) => {
      if (!cloudHostedEnabled()) return notFound(reply, "Not found.");
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const workspaceId = request.params.id;
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { logoStorageKey: null, logoContentType: null, logoSha: null },
      });
      await writeAuditEvent({
        workspaceId,
        userId: auth.userId,
        action: "workspace_logo_removed",
        targetType: "workspace",
        targetId: workspaceId,
      });
      return { ok: true as const };
    });
  });
}