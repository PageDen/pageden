import type { FastifyInstance } from "fastify";
import type { WorkspaceRole } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { hashPassword } from "../passwords.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { canManageWorkspace } from "../permissions/index.js";
import { resolveWorkspaceContext } from "../workspaces/context.js";
import { workspaceLogoUrl } from "../workspaces/logo.js";
import { env } from "../env.js";
import { normalizeHostname, normalizeWorkspaceSubdomain, validateCustomDomain, validateWorkspaceSubdomain } from "../workspaces/domains.js";

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function isMember(userId: string, workspaceId: string): Promise<boolean> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  });
  return membership !== null;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Workspaces the current user belongs to.
  app.get("/api/workspaces", async (request) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId: auth.userId },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, slug: true, subdomain: true, customDomain: true, customDomainStatus: true, logoStorageKey: true, logoSha: true } },
      },
    });
    return {
      workspaces: memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        subdomain: membership.workspace.subdomain,
        customDomain: membership.workspace.customDomain,
        customDomainStatus: membership.workspace.customDomainStatus,
        logoUrl: workspaceLogoUrl(membership.workspace),
        role: membership.role,
      })),
    };
  });

  // Create an additional workspace/company for the signed-in account.
  app.post<{ Body: { name?: string; subdomain?: string } }>("/api/workspaces", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "create");
    const name = request.body.name?.trim() ?? "";
    const subdomainInput = normalizeWorkspaceSubdomain(request.body.subdomain ?? "");
    // Subdomains are a cloud-only concept; self-hosted stores null.
    const subdomain: string | null = env.cloudHosted ? subdomainInput : subdomainInput || null;
    const fields: Record<string, string> = {};
    if (!name) fields.name = "Company name is required.";
    if (env.cloudHosted) {
      const subdomainError = validateWorkspaceSubdomain(subdomainInput);
      if (subdomainError) fields.subdomain = subdomainError;
    }
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    if (subdomain) {
      const existing = await prisma.workspace.findUnique({ where: { subdomain }, select: { id: true } });
      if (existing) return validationError(reply, { subdomain: "That workspace URL is already taken." });
    }

    const base = slugify(name) || subdomain || "workspace";
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name, slug: `${base}-${randomBytes(6).toString("hex")}`, subdomain },
      });
      await tx.workspaceMembership.create({ data: { workspaceId: created.id, userId: auth.userId, role: "admin" } });
      await writeAuditEvent(
        { workspaceId: created.id, userId: auth.userId, action: "workspace_created", targetType: "workspace", targetId: created.id, metadata: { subdomain } },
        tx,
      );
      return created;
    });

    return reply.code(201).send({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        subdomain: workspace.subdomain,
        customDomain: workspace.customDomain,
        customDomainStatus: workspace.customDomainStatus,
        logoUrl: workspaceLogoUrl(workspace),
        role: "admin",
      },
    });
  });

  // Configure a custom domain for a workspace. This only records the desired domain as pending;
  // routing honors custom domains after a separate verification step marks them active.
  app.put<{ Params: { id: string }; Body: { customDomain?: string | null } }>(
    "/api/workspaces/:id/custom-domain",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const workspaceId = request.params.id;
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

      const raw = request.body.customDomain?.trim() ?? "";
      if (!raw) {
        const workspace = await prisma.workspace.update({
          where: { id: workspaceId },
          data: { customDomain: null, customDomainStatus: "pending", customDomainVerifiedAt: null },
        });
        await writeAuditEvent({ workspaceId, userId: auth.userId, action: "custom_domain_removed", targetType: "workspace", targetId: workspaceId });
        return { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, subdomain: workspace.subdomain, customDomain: null, customDomainStatus: workspace.customDomainStatus, logoUrl: workspaceLogoUrl(workspace), role: "admin" } };
      }

      const customDomain = normalizeHostname(raw);
      const domainError = validateCustomDomain(customDomain);
      if (domainError) return validationError(reply, { customDomain: domainError });
      const existing = await prisma.workspace.findFirst({ where: { customDomain, id: { not: workspaceId } }, select: { id: true } });
      if (existing) return validationError(reply, { customDomain: "That custom domain is already assigned to another workspace." });

      const workspace = await prisma.workspace.update({
        where: { id: workspaceId },
        data: { customDomain, customDomainStatus: "pending", customDomainVerifiedAt: null },
      });
      await writeAuditEvent(
        { workspaceId, userId: auth.userId, action: "custom_domain_configured", targetType: "workspace", targetId: workspaceId, metadata: { customDomain } },
      );
      return {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          subdomain: workspace.subdomain,
          customDomain: workspace.customDomain,
          customDomainStatus: workspace.customDomainStatus,
          logoUrl: workspaceLogoUrl(workspace),
          role: "admin",
        },
      };
    },
  );

  // Workspace admins can disable cross-workspace moves out of this workspace.
  // Defaults to enabled for existing workspaces.
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings/workspace-transfer", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const workspaceId = request.params.id;
    if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { workspaceTransferEnabled: true },
    });
    if (!workspace) return notFound(reply, "Workspace not found.");
    return { enabled: workspace.workspaceTransferEnabled };
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/workspaces/:id/settings/workspace-transfer", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const workspaceId = request.params.id;
    if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
    if (typeof request.body?.enabled !== "boolean") return validationError(reply, { enabled: "enabled must be true or false." });
    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: { workspaceTransferEnabled: request.body.enabled },
      select: { workspaceTransferEnabled: true },
    });
    await writeAuditEvent({
      workspaceId,
      userId: auth.userId,
      action: "workspace_transfer_setting_changed",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { enabled: workspace.workspaceTransferEnabled },
    });
    return { enabled: workspace.workspaceTransferEnabled };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings/public-sharing", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const workspaceId = request.params.id;
    if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { publicSharingEnabled: true },
    });
    if (!workspace) return notFound(reply, "Workspace not found.");
    return { enabled: workspace.publicSharingEnabled };
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/workspaces/:id/settings/public-sharing", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const workspaceId = request.params.id;
    if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
    if (typeof request.body?.enabled !== "boolean") return validationError(reply, { enabled: "enabled must be true or false." });
    const workspace = await prisma.workspace.update({
      where: { id: workspaceId },
      data: { publicSharingEnabled: request.body.enabled },
      select: { publicSharingEnabled: true },
    });
    await writeAuditEvent({
      workspaceId,
      userId: auth.userId,
      action: "public_sharing_setting_changed",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { enabled: workspace.publicSharingEnabled },
    });
    return { enabled: workspace.publicSharingEnabled };
  });

  // Phase C2: read the current agent edit scope so the UI can render its picker
  // without having to call the bigger workspace context endpoint.
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/agent-edit-scope",
    { config: { rateLimit: { max: Number(process.env.AGENT_EDIT_SCOPE_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.params.id;
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          agentEditScopeFolderId: true,
          agentEditScopeFolder: { select: { id: true, path: true, name: true } },
        },
      });
      if (!workspace) return notFound(reply, "Workspace not found.");
      return {
        workspaceId: workspace.id,
        agentEditScopeFolderId: workspace.agentEditScopeFolderId,
        agentEditScopeFolder: workspace.agentEditScopeFolder,
      };
    },
  );

  // Phase C2: workspace admins can pin agent token writes to a single folder
  // subtree. Pass `{ folderId: null }` to clear (agents write anywhere again).
  // Read paths are never affected — agents can still search / read across the
  // workspace; this only narrows write scope.
  app.put<{ Params: { id: string }; Body: { folderId?: string | null } }>(
    "/api/workspaces/:id/agent-edit-scope",
    { config: { rateLimit: { max: Number(process.env.AGENT_EDIT_SCOPE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const workspaceId = request.params.id;
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

      const folderId = request.body.folderId ?? null;
      if (folderId !== null) {
        const folder = await prisma.folder.findFirst({
          where: { id: folderId, workspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!folder) return validationError(reply, { folderId: "Folder not found in this workspace." });
      }

      const updated = await prisma.workspace.update({
        where: { id: workspaceId },
        data: { agentEditScopeFolderId: folderId },
        select: { id: true, agentEditScopeFolderId: true },
      });
      await writeAuditEvent({
        workspaceId,
        userId: auth.userId,
        action: "workspace_agent_edit_scope_changed",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { folderId },
      });
      return { workspaceId: updated.id, agentEditScopeFolderId: updated.agentEditScopeFolderId };
    },
  );

  // Current workspace resolved from cloud host, explicit workspace id, or the user's first membership.
  app.get<{ Querystring: { workspaceId?: string } }>("/api/workspaces/current", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const context = await resolveWorkspaceContext(request, auth.userId, request.query.workspaceId);
    if (!context) return notFound(reply, "Workspace not found.");
    const { routingMode, ...workspace } = context;
    return { workspace, routingMode };
  });

  // List workspace members (admin only).
  app.get<{ Querystring: { workspaceId?: string } }>("/api/users", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const workspaceId = request.query.workspaceId;
    if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
    if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

    const memberships = await prisma.workspaceMembership.findMany({
      where: { workspaceId },
      select: { role: true, canViewAudit: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { user: { email: "asc" } },
    });
    return {
      users: memberships.map((membership) => ({
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
        role: membership.role,
        canViewAudit: membership.canViewAudit,
      })),
    };
  });

  // Grant/revoke per-member Audit Log read access (admin only). Admins always
  // have audit access regardless of this flag.
  app.put<{ Params: { workspaceId: string; userId: string }; Body: { canViewAudit?: boolean } }>(
    "/api/workspaces/:workspaceId/members/:userId/audit-access",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const { workspaceId, userId } = request.params;
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);
      const canViewAudit = request.body?.canViewAudit === true;
      const updated = await prisma.workspaceMembership.updateMany({
        where: { workspaceId, userId },
        data: { canViewAudit },
      });
      if (updated.count === 0) return notFound(reply, "Member not found.");
      await writeAuditEvent({
        workspaceId,
        userId: auth.userId,
        action: "member_audit_access_changed",
        targetType: "user",
        targetId: userId,
        metadata: { canViewAudit },
      });
      return { ok: true as const };
    },
  );

  // Create a workspace member (admin only; no public signup).
  app.post<{ Body: { workspaceId?: string; email?: string; name?: string; password?: string; role?: string } }>(
    "/api/users",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const { workspaceId } = request.body;
      const email = request.body.email?.trim().toLowerCase();
      const name = request.body.name?.trim();
      const password = request.body.password ?? "";
      // Phase B: accept viewer/guest tiers alongside the historical member/admin.
      const requestedRole = request.body.role;
      const role: WorkspaceRole =
        requestedRole === "admin" || requestedRole === "viewer" || requestedRole === "guest"
          ? requestedRole
          : "member";

      const fields: Record<string, string> = {};
      if (!workspaceId) fields.workspaceId = "workspaceId is required.";
      if (!email) fields.email = "Email is required.";
      if (!name) fields.name = "Name is required.";
      if (password.length < 8) fields.password = "Password must be at least 8 characters.";
      if (Object.keys(fields).length > 0) return validationError(reply, fields);
      if (!(await canManageWorkspace(auth.userId, workspaceId!))) return forbidden(reply);

      const existing = await prisma.user.findUnique({ where: { email: email! }, select: { id: true } });
      if (existing) {
        const already = await prisma.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: workspaceId!, userId: existing.id } },
          select: { id: true },
        });
        if (already) return validationError(reply, { email: "User is already a member of this workspace." });
      }

      const passwordHash = await hashPassword(password);
      const result = await prisma.$transaction(async (tx) => {
        const user = existing
          ? await tx.user.findUniqueOrThrow({ where: { id: existing.id } })
          : await tx.user.create({
              // Provisioned by an admin into an existing workspace — not a
              // first-run signup, so skip the onboarding redirect.
              data: { email: email!, name: name!, passwordHash, emailVerified: true, onboardedAt: new Date() },
            });
        await tx.workspaceMembership.create({ data: { workspaceId: workspaceId!, userId: user.id, role } });
        await writeAuditEvent(
          { workspaceId: workspaceId!, userId: auth.userId, action: "user_created", targetType: "user", targetId: user.id, metadata: { email, role } },
          tx,
        );
        return user;
      });
      return reply.code(201).send({ id: result.id, email: result.email, name: result.name, role });
    },
  );

  // Groups — members can list; admins manage.
  app.get<{ Querystring: { workspaceId?: string } }>("/api/groups", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const workspaceId = request.query.workspaceId;
    if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
    if (!(await isMember(auth.userId, workspaceId))) return forbidden(reply);
    const groups = await prisma.group.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
    return { groups: groups.map((group) => ({ id: group.id, name: group.name, slug: group.slug })) };
  });

  app.post<{ Body: { workspaceId?: string; name?: string; slug?: string } }>("/api/groups", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const { workspaceId } = request.body;
    const name = request.body.name?.trim();
    const slug = request.body.slug?.trim().toLowerCase();
    const fields: Record<string, string> = {};
    if (!workspaceId) fields.workspaceId = "workspaceId is required.";
    if (!name) fields.name = "Name is required.";
    if (!slug) fields.slug = "Slug is required.";
    if (Object.keys(fields).length > 0) return validationError(reply, fields);
    if (!(await canManageWorkspace(auth.userId, workspaceId!))) return forbidden(reply);

    const existing = await prisma.group.findUnique({
      where: { workspaceId_slug: { workspaceId: workspaceId!, slug: slug! } },
      select: { id: true },
    });
    if (existing) return validationError(reply, { slug: "A group with this slug already exists." });

    const group = await prisma.group.create({ data: { workspaceId: workspaceId!, name: name!, slug: slug! } });
    await writeAuditEvent({ workspaceId: workspaceId!, userId: auth.userId, action: "group_created", targetType: "group", targetId: group.id, metadata: { slug } });
    return reply.code(201).send({ id: group.id, name: group.name, slug: group.slug });
  });

  app.post<{ Params: { id: string }; Body: { userId?: string } }>("/api/groups/:id/members", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const targetUserId = request.body.userId;
    if (!targetUserId) return validationError(reply, { userId: "userId is required." });
    const group = await prisma.group.findUnique({ where: { id: request.params.id }, select: { id: true, workspaceId: true } });
    if (!group) return notFound(reply, "Group not found.");
    if (!(await canManageWorkspace(auth.userId, group.workspaceId))) return forbidden(reply);
    if (!(await isMember(targetUserId, group.workspaceId))) {
      return validationError(reply, { userId: "User is not a member of this workspace." });
    }
    await prisma.groupMembership.upsert({
      where: { groupId_userId: { groupId: group.id, userId: targetUserId } },
      update: {},
      create: { groupId: group.id, userId: targetUserId },
    });
    await writeAuditEvent({ workspaceId: group.workspaceId, userId: auth.userId, action: "group_member_added", targetType: "group", targetId: group.id, metadata: { userId: targetUserId } });
    return reply.code(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/groups/:id/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const group = await prisma.group.findUnique({ where: { id: request.params.id }, select: { id: true, workspaceId: true } });
    if (!group) return notFound(reply, "Group not found.");
    if (!(await canManageWorkspace(auth.userId, group.workspaceId))) return forbidden(reply);
    await prisma.groupMembership.deleteMany({ where: { groupId: group.id, userId: request.params.userId } });
    await writeAuditEvent({ workspaceId: group.workspaceId, userId: auth.userId, action: "group_member_removed", targetType: "group", targetId: group.id, metadata: { userId: request.params.userId } });
    return { ok: true };
  });

  // Audit log (admin), paginated by ?before= (an audit event id cursor).
  app.get<{ Querystring: { workspaceId?: string; before?: string; limit?: string } }>(
    "/api/audit",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

      if (request.query.limit !== undefined && !/^[1-9][0-9]*$/.test(request.query.limit)) {
        return validationError(reply, { limit: "limit must be a positive integer." });
      }
      const limit = Math.min(Number(request.query.limit ?? 50), 200);
      let cursor: { createdAt: Date; id: string } | null = null;
      if (request.query.before) {
        cursor = await prisma.auditEvent.findUnique({
          where: { id: request.query.before },
          select: { createdAt: true, id: true },
        });
      }
      // Stable tuple cursor (createdAt, id) so events sharing a timestamp are not skipped.
      const events = await prisma.auditEvent.findMany({
        where: {
          workspaceId,
          ...(cursor
            ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = events.slice(0, limit);
      const nextBefore = events.length > limit ? (page[page.length - 1]?.id ?? null) : null;
      return {
        events: page.map((event) => ({
          id: event.id,
          userId: event.userId,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          ipAddress: event.ipAddress,
          createdAt: event.createdAt.toISOString(),
          metadata: event.metadata,
        })),
        nextBefore,
      };
    },
  );
}
