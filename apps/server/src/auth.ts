import type { FastifyRequest } from "fastify";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { openSession, SESSION_COOKIE } from "./session.js";
import { hashToken } from "./tokens.js";
import { writeAuditEvent } from "./audit.js";

export interface AuthContext {
  userId: string;
  authType: "session" | "token";
  tokenId?: string;
  tokenName?: string;
  tokenKind?: string;
  tokenScopes?: string[];
  tokenWorkspaceId?: string | null;
}

export const TOKEN_SCOPES = ["search", "read", "create", "update", "append", "attachments"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

export function requireTokenScope(auth: AuthContext, scope: TokenScope): void {
  if (auth.authType !== "token") return;
  if (auth.tokenScopes?.includes(scope)) return;
  throw Object.assign(new Error("forbidden"), { statusCode: 403 });
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export async function authenticate(request: FastifyRequest): Promise<AuthContext | null> {
  const opened = openSession(request.cookies[SESSION_COOKIE], env.sessionSecret);
  if (opened) {
    const user = await prisma.user.findUnique({
      where: { id: opened.userId },
      select: { id: true, sessionVersion: true },
    });
    // A valid-but-stale cookie (password changed/reset bumped sessionVersion) is rejected.
    return user && user.sessionVersion === opened.v ? { userId: user.id, authType: "session" } : null;
  }

  const rawToken = bearerToken(request);
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken, env.tokenHashSecret);
  const token = await prisma.apiToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, name: true, kind: true, scopes: true, workspaceId: true, expiresAt: true, revokedAt: true },
  });
  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) return null;

  await prisma.apiToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date(), lastUsedIp: request.ip },
  });
  await writeAuditEvent({
    userId: token.userId,
    action: "token_used",
    targetType: "api_token",
    targetId: token.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { name: token.name, kind: token.kind },
  });

  return {
    userId: token.userId,
    authType: "token",
    tokenId: token.id,
    tokenName: token.name,
    tokenKind: token.kind,
    tokenScopes: token.scopes,
    tokenWorkspaceId: token.workspaceId,
  };
}

export async function requireAuth(request: FastifyRequest): Promise<AuthContext> {
  const auth = await authenticate(request);
  if (!auth) {
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  }
  return auth;
}
