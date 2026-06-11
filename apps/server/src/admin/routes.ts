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
        workspace: { select: { id: true, name: true, slug: true, subdomain: true, customDomain: true, customDomainStatus: true } },
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
        role: membership.role,
      })),
    };
  });

  // Create an additional workspace/company for the signed-in account.
  app.post<{ Body: { name?: string; subdomain?: string } }>("/api/workspaces", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "create");
    const name = request.body.name?.trim() ?? "";
    const subdomain = normalizeWorkspaceSubdomain(request.body.subdomain ?? "");
    const fields: Record<string, string> = {};
    if (!name) fields.name = "Company name is required.";
    const subdomainError = validateWorkspaceSubdomain(subdomain);
    if (subdomainError) fields.subdomain = subdomainError;
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    const existing = await prisma.workspace.findUnique({ where: { subdomain }, select: { id: true } });
    if (existing) return validationError(reply, { subdomain: "That workspace URL is already taken." });

    const base = slugify(name) || subdomain;
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
        return { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, subdomain: workspace.subdomain, customDomain: null, customDomainStatus: workspace.customDomainStatus, role: "admin" } };
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
          role: "admin",
        },
      };
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
      select: { role: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { user: { email: "asc" } },
    });
    return {
      users: memberships.map((membership) => ({
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
        role: membership.role,
      })),
    };
  });

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
      const role: WorkspaceRole = request.body.role === "admin" ? "admin" : "member";

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
          : await tx.user.create({ data: { email: email!, name: name!, passwordHash, emailVerified: true } });
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
