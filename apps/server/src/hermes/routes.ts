import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { isUniqueViolation, validationError } from "../errors.js";
import { requireAuth } from "../auth.js";
import { prisma } from "../prisma.js";

const CONNECT_TTL_MS = 15 * 60 * 1000;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_PROVIDER_ACCOUNT_ID = 128;
const MAX_PROVIDER_USERNAME = 128;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createConnectToken(): string {
  return `pm_hermes_${randomBytes(32).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || authorization.length < 7) return null;
  if (authorization.slice(0, 6).toLowerCase() !== "bearer") return null;
  let i = 6;
  while (i < authorization.length) {
    const c = authorization.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  if (i === 6) return null;
  const token = authorization.slice(i);
  return token.length > 0 ? token : null;
}

function requireHermesService(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = process.env.HERMES_SERVICE_SECRET ?? env.hermesServiceSecret;
  if (!configured) {
    reply.code(503).send({ error: "service_unavailable", message: "Hermes service authentication is not configured." });
    return false;
  }
  const token = bearerToken(request);
  if (!token || !safeEqual(token, configured)) {
    reply.code(401).send({ error: "unauthorized", message: "Hermes service authentication required." });
    return false;
  }
  return true;
}

function normalizeProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  return PROVIDER_RE.test(provider) ? provider : null;
}

function normalizeProviderAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_PROVIDER_ACCOUNT_ID ? id : null;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : undefined;
}

function parsePlatformIdentity(body: unknown): {
  provider: string;
  providerAccountId: string;
  providerUsername?: string | null;
  providerMetadata?: object | null;
} | { fields: Record<string, string> } {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const provider = normalizeProvider(input.provider);
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);
  const providerUsername = normalizeOptionalString(input.providerUsername, MAX_PROVIDER_USERNAME);
  const fields: Record<string, string> = {};
  if (!provider) fields.provider = "Expected a provider like discord or telegram.";
  if (!providerAccountId) fields.providerAccountId = "Expected a stable platform account id.";
  if (providerUsername === undefined && "providerUsername" in input) fields.providerUsername = "Expected a short display name.";
  const providerMetadata =
    input.providerMetadata === undefined || input.providerMetadata === null
      ? null
      : typeof input.providerMetadata === "object" && !Array.isArray(input.providerMetadata)
        ? (input.providerMetadata as object)
        : undefined;
  if (providerMetadata === undefined) fields.providerMetadata = "Expected an object.";
  if (Object.keys(fields).length > 0) return { fields };
  return { provider: provider!, providerAccountId: providerAccountId!, providerUsername, providerMetadata };
}

async function resolveActiveLink(provider: string, providerAccountId: string, touch = false) {
  const link = await prisma.externalAccountLink.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: {
      id: true,
      userId: true,
      provider: true,
      providerAccountId: true,
      providerUsername: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!link || link.revokedAt) return null;
  if (!touch) return link;
  return prisma.externalAccountLink.update({
    where: { id: link.id },
    data: { lastUsedAt: new Date() },
    select: {
      id: true,
      userId: true,
      provider: true,
      providerAccountId: true,
      providerUsername: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

async function confirmConnectSession(input: { sessionId: string; rawToken: string; userId: string }) {
  const now = new Date();
  const tokenHash = sha256(input.rawToken);

  return prisma.$transaction(async (tx) => {
    const session = await tx.hermesConnectSession.findUnique({
      where: { id: input.sessionId },
      select: {
        id: true,
        tokenHash: true,
        provider: true,
        providerAccountId: true,
        providerUsername: true,
        providerMetadata: true,
        expiresAt: true,
        usedAt: true,
      },
    });
    if (!session || session.tokenHash !== tokenHash || session.usedAt || session.expiresAt <= now) return { status: "not_found" as const };

    const existing = await tx.externalAccountLink.findUnique({
      where: { provider_providerAccountId: { provider: session.provider, providerAccountId: session.providerAccountId } },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (existing && existing.userId !== input.userId && !existing.revokedAt) return { status: "linked_elsewhere" as const, provider: session.provider };

    let link;
    if (existing) {
      link = await tx.externalAccountLink.update({
        where: { id: existing.id },
        data: {
          userId: input.userId,
          providerUsername: session.providerUsername,
          providerMetadata: session.providerMetadata ?? undefined,
          revokedAt: null,
          lastUsedAt: now,
        },
      });
    } else {
      try {
        link = await tx.externalAccountLink.create({
          data: {
            userId: input.userId,
            provider: session.provider,
            providerAccountId: session.providerAccountId,
            providerUsername: session.providerUsername,
            providerMetadata: session.providerMetadata ?? undefined,
            lastUsedAt: now,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { status: "linked_elsewhere" as const, provider: session.provider };
        throw error;
      }
    }

    await tx.hermesConnectSession.update({ where: { id: session.id }, data: { usedAt: now } });
    return { status: "linked" as const, link };
  });
}

function sendConfirmResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof confirmConnectSession>>,
  options: { html?: boolean } = {},
) {
  if (result.status === "not_found") {
    if (options.html) return reply.code(404).type("text/html").send("<h1>Connect link expired</h1>");
    return reply.code(404).send({ error: "not_found", message: "Connect session not found or expired." });
  }
  if (result.status === "linked_elsewhere") {
    const message = `This ${result.provider} account is already linked to another PageDen account — disconnect it there first.`;
    if (options.html) return reply.code(409).type("text/html").send(`<h1>Already linked</h1><p>${escapeHtml(message)}</p>`);
    return reply.code(409).send({ error: "already_linked", message });
  }
  if (options.html) return reply.type("text/html").send("<h1>Hermes connected</h1><p>You can return to your chat app.</p>");
  return reply.send({ link: linkDto(result.link) });
}

function linkDto(link: {
  id: string;
  provider: string;
  providerAccountId: string;
  providerUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: link.id,
    provider: link.provider,
    providerAccountId: link.providerAccountId,
    providerUsername: link.providerUsername,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
    lastUsedAt: link.lastUsedAt ? link.lastUsedAt.toISOString() : null,
    revokedAt: link.revokedAt ? link.revokedAt.toISOString() : null,
  };
}

export async function registerHermesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>("/api/hermes/connect-sessions", async (request, reply) => {
    if (!requireHermesService(request, reply)) return;
    const parsed = parsePlatformIdentity(request.body);
    if ("fields" in parsed) return validationError(reply, parsed.fields);

    const rawToken = createConnectToken();
    const session = await prisma.hermesConnectSession.create({
      data: {
        tokenHash: sha256(rawToken),
        provider: parsed.provider,
        providerAccountId: parsed.providerAccountId,
        providerUsername: parsed.providerUsername,
        providerMetadata: parsed.providerMetadata ?? undefined,
        expiresAt: new Date(Date.now() + CONNECT_TTL_MS),
      },
      select: { id: true, expiresAt: true },
    });

    return reply.code(201).send({
      sessionId: session.id,
      connectUrl: `${env.appUrl}/hermes/connect?token=${encodeURIComponent(rawToken)}`,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.get<{ Querystring: { token?: string } }>("/hermes/connect", async (request, reply) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    const session = token
      ? await prisma.hermesConnectSession.findUnique({
          where: { tokenHash: sha256(token) },
          select: { id: true, provider: true, providerAccountId: true, providerUsername: true, expiresAt: true, usedAt: true },
        })
      : null;
    if (!session || session.usedAt || session.expiresAt <= new Date()) {
      return reply.code(404).type("text/html").send("<h1>Connect link expired</h1>");
    }

    const auth = await requireAuth(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true, name: true } });
    reply.header("Referrer-Policy", "no-referrer");
    return reply.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connect Hermes</title></head>
<body>
  <h1>Connect Hermes</h1>
  <p>Link PageDen account ${escapeHtml(user.email)} to ${escapeHtml(session.provider)} user ${escapeHtml(session.providerUsername ?? session.providerAccountId)}?</p>
  <form method="get" action="/api/hermes/connect-sessions/${encodeURIComponent(session.id)}/confirm">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">Connect</button>
  </form>
</body></html>`);
  });

  app.post<{ Params: { id: string }; Body: { token?: string }; Querystring: { token?: string } }>(
    "/api/hermes/connect-sessions/:id/confirm",
    async (request, reply) => {
      const auth = await requireAuth(request);
      const rawToken = request.body?.token ?? request.query.token ?? "";
      if (!rawToken) return validationError(reply, { token: "Connect token is required." });
      return sendConfirmResult(reply, await confirmConnectSession({ sessionId: request.params.id, rawToken, userId: auth.userId }));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/api/hermes/connect-sessions/:id/confirm", async (request, reply) => {
    const auth = await requireAuth(request);
    const rawToken = request.query.token ?? "";
    if (!rawToken) return reply.code(400).type("text/html").send("<h1>Missing connect token</h1>");
    return sendConfirmResult(reply, await confirmConnectSession({ sessionId: request.params.id, rawToken, userId: auth.userId }), { html: true });
  });

  app.get<{ Querystring: { provider?: string; providerAccountId?: string } }>("/api/hermes/link-status", async (request, reply) => {
    if (!requireHermesService(request, reply)) return;
    const parsed = parsePlatformIdentity(request.query);
    if ("fields" in parsed) return validationError(reply, parsed.fields);
    const link = await resolveActiveLink(parsed.provider, parsed.providerAccountId, true);
    return { linked: Boolean(link), link: link ? linkDto(link) : null };
  });

  app.get("/api/me/external-links", async (request) => {
    const auth = await requireAuth(request);
    const links = await prisma.externalAccountLink.findMany({
      where: { userId: auth.userId },
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    });
    return { links: links.map(linkDto) };
  });

  app.delete<{ Params: { id: string } }>("/api/me/external-links/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    const link = await prisma.externalAccountLink.findFirst({ where: { id: request.params.id, userId: auth.userId } });
    if (!link) return reply.code(404).send({ error: "not_found", message: "External account link not found." });
    const updated = await prisma.externalAccountLink.update({
      where: { id: link.id },
      data: { revokedAt: link.revokedAt ?? new Date() },
    });
    return { link: linkDto(updated) };
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
