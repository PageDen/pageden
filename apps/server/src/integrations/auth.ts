import type { FastifyRequest } from "fastify";
import type { WorkspaceIntegration } from "@prisma/client";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { hashToken } from "../tokens.js";

export type { WorkspaceIntegration };

export interface IntegrationContext {
  integration: WorkspaceIntegration;
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header) return null;
  const lower = header.slice(0, 6).toLowerCase();
  if (lower !== "basic ") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 1) return null;
  return { clientId: decoded.slice(0, colonIdx), clientSecret: decoded.slice(colonIdx + 1) };
}

export async function requireIntegrationAuth(request: FastifyRequest): Promise<IntegrationContext> {
  const creds = parseBasicAuth(request.headers.authorization);
  if (!creds) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });

  const secretHash = hashToken(creds.clientSecret, env.tokenHashSecret);
  const integration = await prisma.workspaceIntegration.findFirst({
    where: { clientId: creds.clientId, clientSecretHash: secretHash, revokedAt: null },
  });
  if (!integration) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });

  void prisma.workspaceIntegration.update({
    where: { id: integration.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return { integration };
}

export function requireIntegrationScope(integration: WorkspaceIntegration, scope: string): void {
  if (integration.scopes.includes(scope)) return;
  throw Object.assign(new Error("forbidden"), { statusCode: 403 });
}
