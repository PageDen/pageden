import type { FastifyRequest } from "fastify";
import { CustomDomainStatus, type Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requestHost, workspaceRouteFromHost } from "./domains.js";

export type WorkspaceRoutingMode = "cloud_subdomain" | "custom_domain" | "self_hosted" | "explicit";

export interface WorkspaceContext {
  id: string;
  name: string;
  slug: string;
  subdomain: string | null;
  customDomain: string | null;
  customDomainStatus: "pending" | "verified" | "active" | "failed";
  role: "member" | "admin";
  routingMode: WorkspaceRoutingMode;
}

export async function resolveWorkspaceContext(
  request: FastifyRequest,
  userId: string,
  explicitWorkspaceId?: string | null,
): Promise<WorkspaceContext | null> {
  const route = workspaceRouteFromHost(requestHost(request));
  const where: Prisma.WorkspaceMembershipWhereInput = route
    ? {
        userId,
        workspace:
          route.mode === "cloud_subdomain"
            ? { subdomain: route.subdomain }
            : { customDomain: route.customDomain, customDomainStatus: CustomDomainStatus.active },
      }
    : explicitWorkspaceId
      ? { userId, workspaceId: explicitWorkspaceId }
      : { userId };

  const membership = await prisma.workspaceMembership.findFirst({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          subdomain: true,
          customDomain: true,
          customDomainStatus: true,
        },
      },
    },
  });
  if (!membership) return null;

  return {
    ...membership.workspace,
    role: membership.role,
    routingMode: route?.mode ?? (explicitWorkspaceId ? "explicit" : "self_hosted"),
  };
}
