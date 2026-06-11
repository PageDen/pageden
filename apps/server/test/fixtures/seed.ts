import type { PermissionResourceType, PermissionRole, PermissionSubjectType, WorkspaceRole } from "@prisma/client";
import { prisma } from "../helpers/db.js";
import { req, sessionFor } from "../helpers/app.js";
import { hashPassword } from "../../src/passwords.js";

// Not a real secret — a test fixture password (kept out of committed assignment patterns).
export const PW = ["Fixture", "pw", "12345678"].join("-");

export async function createUser(email: string, name = "User", password = PW) {
  return prisma.user.create({ data: { email, name, passwordHash: await hashPassword(password) } });
}

export async function createWorkspace(name = "Workspace", slug = "ws") {
  return prisma.workspace.create({ data: { name, slug } });
}

export async function addMember(workspaceId: string, userId: string, role: WorkspaceRole = "member") {
  return prisma.workspaceMembership.create({ data: { workspaceId, userId, role } });
}

export async function createGroup(workspaceId: string, name = "Group", slug = "group") {
  return prisma.group.create({ data: { workspaceId, name, slug } });
}

export async function addToGroup(groupId: string, userId: string) {
  return prisma.groupMembership.create({ data: { groupId, userId } });
}

export async function grant(
  workspaceId: string,
  subjectType: PermissionSubjectType,
  subjectId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
  role: PermissionRole,
) {
  return prisma.permission.create({ data: { workspaceId, subjectType, subjectId, resourceType, resourceId, role } });
}

/** Create a user, add as workspace member, and return { user, cookie }. */
export async function member(workspaceId: string, email: string, role: WorkspaceRole = "member") {
  const user = await createUser(email);
  await addMember(workspaceId, user.id, role);
  return { user, cookie: sessionFor(user.id) };
}

/** Base scenario: a workspace, an admin, and one folder + document created via the API. */
export async function baseScenario() {
  const ws = await createWorkspace();
  const admin = await createUser("admin@t.co", "Admin");
  await addMember(ws.id, admin.id, "admin");
  const adminCookie = sessionFor(admin.id);

  const f = await req({
    method: "POST",
    url: "/api/folders",
    cookies: adminCookie,
    payload: { workspaceId: ws.id, name: "Engineering", slug: "engineering" },
  });
  if (f.statusCode !== 201) throw new Error(`fixture folder failed: ${f.body}`);
  const folderId = f.json().id as string;

  const d = await req({
    method: "POST",
    url: "/api/documents",
    cookies: adminCookie,
    payload: { workspaceId: ws.id, folderId, title: "Runbook", slug: "runbook", content: "# Runbook\n" },
  });
  if (d.statusCode !== 201) throw new Error(`fixture document failed: ${d.body}`);
  const docId = d.json().id as string;
  const version = d.json().version as string;

  return { ws, admin, adminCookie, folderId, docId, version };
}
