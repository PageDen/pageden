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

/**
 * Best-effort SVG hardening: strip scripts, event-handler attributes, external
 * fetching elements, and javascript: URLs. Defense-in-depth only — the serve
 * route also sends a restrictive CSP + nosniff so a missed vector still can't
 * execute. Returns the cleaned markup.
 */
export function sanitizeSvg(input: Buffer): Buffer {
  let svg = input.toString("utf8");
  svg = svg.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "");
  svg = svg.replace(/<\s*script[\s\S]*?\/\s*>/gi, "");
  svg = svg.replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, "");
  // on*="..." / on*='...' event handlers
  svg = svg.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // javascript: in href/xlink:href/src/style
  svg = svg.replace(/(href|xlink:href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
  return Buffer.from(svg, "utf8");
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