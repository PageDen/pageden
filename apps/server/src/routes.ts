import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";
import { prisma } from "./prisma.js";
import { sealSession, SESSION_COOKIE } from "./session.js";
import { env } from "./env.js";
import { isTokenScope, requireAuth, TOKEN_SCOPES } from "./auth.js";
import { createRawToken, hashToken } from "./tokens.js";
import { writeAuditEvent } from "./audit.js";
import { forbidden, isUniqueViolation, notFound, validationError } from "./errors.js";
import { getMailer } from "./mailer.js";
import { generateCodeVerifier, generateState, getGoogleClient, type GoogleProfile } from "./google.js";
import { registerDocumentRoutes } from "./documents/routes.js";
import { registerFolderRoutes } from "./folders/routes.js";
import { registerPermissionRoutes } from "./permissions/routes.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerDeviceRoutes } from "./device/routes.js";
import { registerAttachmentRoutes } from "./attachments/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { normalizeWorkspaceSubdomain, requestHost, validateWorkspaceSubdomain, workspaceRouteFromHost } from "./workspaces/domains.js";

const MIN_PASSWORD_LENGTH = 8;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.nodeEnv === "production",
  path: "/",
};

function userDto(user: { id: string; email: string; name: string }) {
  return { id: user.id, email: user.email, name: user.name };
}

async function mePayload(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      workspaceMemberships: {
        select: {
          role: true,
          workspace: { select: { id: true, name: true, slug: true, subdomain: true, customDomain: true, customDomainStatus: true } },
        },
      },
    },
  });

  return {
    user: userDto(user),
    emailVerified: user.emailVerified,
    workspaces: user.workspaceMemberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      subdomain: membership.workspace.subdomain,
      customDomain: membership.workspace.customDomain,
      customDomainStatus: membership.workspace.customDomainStatus,
      role: membership.role,
    })),
  };
}

// Resolve a Google profile to a user id: an existing linked account logs in; a verified email
// matching an existing user links Google to it; otherwise a new user + workspace is created.
async function resolveGoogleUser(profile: GoogleProfile): Promise<string | null> {
  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.sub } },
    select: { userId: true },
  });
  if (linked) return linked.userId;

  const existing = await prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
  if (existing) {
    // Only auto-link to a pre-existing account when Google asserts the email is verified, so an
    // unverified Google email can't hijack someone else's account.
    if (!profile.emailVerified) return null;
    await prisma.oAuthAccount.create({ data: { userId: existing.id, provider: "google", providerAccountId: profile.sub } });
    await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: true } });
    return existing.id;
  }

  // Creating a brand-new account via Google must honor the same self-signup policy as password
  // registration (linking/login to an existing account is still allowed when signup is disabled).
  if (process.env.AUTH_ALLOW_SIGNUP === "false") return null;
  const name = profile.name || profile.email.split("@")[0] || "User";
  const base = slugify(name) || "workspace";
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: profile.email, name, passwordHash: null, emailVerified: profile.emailVerified },
    });
    const workspace = await tx.workspace.create({
      data: { name: `${name}'s workspace`, slug: `${base}-${randomBytes(6).toString("hex")}` },
    });
    await tx.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: user.id, role: "admin" } });
    await tx.oAuthAccount.create({ data: { userId: user.id, provider: "google", providerAccountId: profile.sub } });
    return user;
  });
  return created.id;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerAdminRoutes(app);
  await registerDeviceRoutes(app);
  await registerFolderRoutes(app);
  await registerDocumentRoutes(app);
  await registerAttachmentRoutes(app);
  await registerMcpRoutes(app);
  await registerPermissionRoutes(app);

  app.get<{ Querystring: { subdomain?: string } }>("/api/workspaces/availability", async (request) => {
    const subdomain = normalizeWorkspaceSubdomain(request.query.subdomain ?? "");
    const reason = validateWorkspaceSubdomain(subdomain);
    if (reason) return { available: false, subdomain, reason };
    const existing = await prisma.workspace.findUnique({ where: { subdomain }, select: { id: true } });
    return {
      available: existing === null,
      subdomain,
      reason: existing ? "That workspace URL is already taken." : null,
    };
  });

  app.get("/api/workspaces/current-public", async (request) => {
    const route = workspaceRouteFromHost(requestHost(request));
    if (!route) return { workspace: null, routingMode: null };

    const workspace = await prisma.workspace.findFirst({
      where:
        route.mode === "cloud_subdomain"
          ? { subdomain: route.subdomain }
          : { customDomain: route.customDomain, customDomainStatus: "active" },
      select: { id: true, name: true, slug: true, subdomain: true, customDomain: true },
    });

    return { workspace, routingMode: workspace ? route.mode : null };
  });

  app.post<{
    Body: { email?: string; password?: string };
  }>(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 5), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const email = request.body.email?.trim().toLowerCase();
      const password = request.body.password ?? "";
      if (!email || !password) {
        return reply.code(400).send({
          error: "validation_error",
          fields: { email: "Email is required.", password: "Password is required." },
        });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
        await writeAuditEvent({
          action: "login_failed",
          targetType: "user",
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { email },
        });
        return reply.code(401).send({ error: "unauthorized", message: "Invalid email or password." });
      }

      reply.setCookie(SESSION_COOKIE, sealSession(user.id, user.sessionVersion, env.sessionSecret), COOKIE_OPTIONS);
      await writeAuditEvent({
        userId: user.id,
        action: "login_succeeded",
        targetType: "user",
        targetId: user.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return mePayload(user.id);
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await requireAuth(request);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    await writeAuditEvent({
      userId: auth.userId,
      action: "logout",
      targetType: "user",
      targetId: auth.userId,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    return { ok: true };
  });

  // Change the signed-in user's password: verify the current one, then store a fresh argon2id hash.
  // Rate-limited because it verifies a password (brute-force vector even from a valid session).
  // NOTE (MVP): sessions are stateless sealed cookies and bearer tokens are separate credentials,
  // so a password change does NOT revoke existing sessions/tokens. A passwordChangedAt/version
  // embedded in the cookie + checked in openSession is the planned follow-up.
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    "/api/auth/change-password",
    {
      config: {
        rateLimit: { max: Number(process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX ?? 10), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const auth = await requireAuth(request);
      const currentPassword = request.body?.currentPassword ?? "";
      const newPassword = request.body?.newPassword ?? "";
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return validationError(reply, { newPassword: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      }

      const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { passwordHash: true } });
      if (!user) return reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
      if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
        await writeAuditEvent({
          userId: auth.userId,
          action: "password_change_failed",
          targetType: "user",
          targetId: auth.userId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        });
        return validationError(reply, { currentPassword: "Current password is incorrect." });
      }

      const updated = await prisma.user.update({
        where: { id: auth.userId },
        data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } },
        select: { sessionVersion: true },
      });
      // Bumping sessionVersion invalidates every existing session cookie; re-issue one for the
      // current session so the user who just changed their password stays signed in here.
      reply.setCookie(SESSION_COOKIE, sealSession(auth.userId, updated.sessionVersion, env.sessionSecret), COOKIE_OPTIONS);
      await writeAuditEvent({
        userId: auth.userId,
        action: "password_changed",
        targetType: "user",
        targetId: auth.userId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return { ok: true };
    },
  );

  // Request a password reset. Always returns 200 so callers can't probe which emails exist;
  // when the email matches a user we invalidate any prior unused links and email a fresh one.
  app.post<{ Body: { email?: string } }>(
    "/api/auth/forgot-password",
    {
      config: {
        rateLimit: { max: Number(process.env.FORGOT_PASSWORD_RATE_LIMIT_MAX ?? 5), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const email = request.body?.email?.trim().toLowerCase() ?? "";
      if (!email) return validationError(reply, { email: "Email is required." });

      const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (user) {
        await prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        const raw = createRawToken();
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(raw, env.tokenHashSecret),
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          },
        });
        const resetUrl = `${env.webOrigin}/reset-password?token=${encodeURIComponent(raw)}`;
        // Fire-and-forget so a slow/real email send doesn't make existing-account requests
        // measurably slower than unknown-account ones (timing-based enumeration).
        void getMailer()
          .sendPasswordReset(email, resetUrl)
          .catch((error) => request.log.error(error, "failed to send password reset email"));
        await writeAuditEvent({
          userId: user.id,
          action: "password_reset_requested",
          targetType: "user",
          targetId: user.id,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        });
      }
      return { ok: true };
    },
  );

  // Complete a password reset with the emailed token: single-use, time-limited, and it bumps
  // sessionVersion so every existing session for that account is invalidated.
  app.post<{ Body: { token?: string; password?: string } }>(
    "/api/auth/reset-password",
    {
      config: {
        rateLimit: { max: Number(process.env.RESET_PASSWORD_RATE_LIMIT_MAX ?? 10), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const token = request.body?.token ?? "";
      const password = request.body?.password ?? "";
      if (password.length < MIN_PASSWORD_LENGTH) {
        return validationError(reply, { password: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      }
      if (!token) return validationError(reply, { token: "A reset token is required." });

      const record = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(token, env.tokenHashSecret) },
        select: { id: true, userId: true, usedAt: true, expiresAt: true },
      });
      if (!record || record.usedAt || record.expiresAt <= new Date()) {
        return validationError(reply, { token: "This reset link is invalid or has expired." });
      }

      const newHash = await hashPassword(password);
      // Claim the token atomically: only the transaction that flips usedAt null→now (and sees it
      // unexpired) proceeds, so a token can never be double-spent under concurrency. A reset is a
      // full logout — it also bumps sessionVersion (all cookies) and revokes the user's API tokens
      // (possible account-recovery-after-compromise).
      let claimed = false;
      await prisma.$transaction(async (tx) => {
        const claim = await tx.passwordResetToken.updateMany({
          where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (claim.count !== 1) return;
        claimed = true;
        await tx.user.update({
          where: { id: record.userId },
          data: { passwordHash: newHash, sessionVersion: { increment: 1 } },
        });
        await tx.apiToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      if (!claimed) return validationError(reply, { token: "This reset link is invalid or has expired." });
      await writeAuditEvent({
        userId: record.userId,
        action: "password_reset",
        targetType: "user",
        targetId: record.userId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return { ok: true };
    },
  );

  // Open self-signup: create the user + their own workspace (as admin), sign them in, and send a
  // verification email. Email verification is non-blocking (the account is usable immediately);
  // the web shows a "verify your email" banner driven by /api/me.
  app.post<{ Body: { email?: string; name?: string; password?: string; companyName?: string; subdomain?: string } }>(
    "/api/auth/register",
    {
      config: {
        rateLimit: { max: Number(process.env.REGISTER_RATE_LIMIT_MAX ?? 5), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      // Deployers can disable open self-signup (e.g. invite-only installs). NOTE: a public,
      // internet-facing deployment should add abuse controls (CAPTCHA, per-domain/global quotas)
      // before enabling this — per-IP rate limiting alone is not sufficient against spam signups.
      if (process.env.AUTH_ALLOW_SIGNUP === "false") return forbidden(reply, "Self-signup is disabled.");
      const email = request.body?.email?.trim().toLowerCase() ?? "";
      const name = request.body?.name?.trim() ?? "";
      const password = request.body?.password ?? "";
      const companyName = request.body?.companyName?.trim() ?? "";
      const subdomain = normalizeWorkspaceSubdomain(request.body?.subdomain ?? "");
      const fields: Record<string, string> = {};
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fields.email = "A valid email is required.";
      if (!name) fields.name = "Name is required.";
      if (!companyName) fields.companyName = "Company name is required.";
      const subdomainError = validateWorkspaceSubdomain(subdomain);
      if (subdomainError) fields.subdomain = subdomainError;
      if (password.length < MIN_PASSWORD_LENGTH) fields.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
      if (Object.keys(fields).length > 0) return validationError(reply, fields);

      if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
        return validationError(reply, { email: "An account with this email already exists." });
      }

      const passwordHash = await hashPassword(password);
      const base = slugify(companyName) || subdomain;
      let created: { user: { id: string }; workspace: { id: string } };
      try {
        created = await prisma.$transaction(async (tx) => {
          if (await tx.workspace.findUnique({ where: { subdomain }, select: { id: true } })) {
            throw new Error("SUBDOMAIN_TAKEN");
          }
          const user = await tx.user.create({ data: { email, name, passwordHash, emailVerified: false } });
          const workspace = await tx.workspace.create({
            data: { name: companyName, slug: `${base}-${randomBytes(6).toString("hex")}`, subdomain },
          });
          await tx.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: user.id, role: "admin" } });
          return { user, workspace };
        });
      } catch (error) {
        if (error instanceof Error && error.message === "SUBDOMAIN_TAKEN") {
          return validationError(reply, { subdomain: "That workspace URL is already taken." });
        }
        // Concurrent duplicate registration (or the rare slug clash) trips a unique constraint.
        if (isUniqueViolation(error)) return validationError(reply, { email: "An account or workspace with those details already exists." });
        throw error;
      }

      const raw = createRawToken();
      await prisma.emailVerificationToken.create({
        data: {
          userId: created.user.id,
          tokenHash: hashToken(raw, env.tokenHashSecret),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });
      const verifyUrl = `${env.webOrigin}/verify-email?token=${encodeURIComponent(raw)}`;
      void getMailer()
        .sendEmailVerification(email, verifyUrl)
        .catch((error) => request.log.error(error, "failed to send verification email"));

      await writeAuditEvent({
        userId: created.user.id,
        workspaceId: created.workspace.id,
        action: "user_registered",
        targetType: "user",
        targetId: created.user.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      reply.setCookie(SESSION_COOKIE, sealSession(created.user.id, 0, env.sessionSecret), COOKIE_OPTIONS);
      return mePayload(created.user.id);
    },
  );

  // Confirm an email address with the emailed token (single-use, time-limited).
  app.post<{ Body: { token?: string } }>(
    "/api/auth/verify-email",
    {
      config: {
        rateLimit: { max: Number(process.env.VERIFY_EMAIL_RATE_LIMIT_MAX ?? 20), timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const token = request.body?.token ?? "";
      if (!token) return validationError(reply, { token: "A verification token is required." });
      const record = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(token, env.tokenHashSecret) },
        select: { id: true, userId: true, usedAt: true, expiresAt: true },
      });
      if (!record || record.usedAt || record.expiresAt <= new Date()) {
        return validationError(reply, { token: "This verification link is invalid or has expired." });
      }
      let claimed = false;
      await prisma.$transaction(async (tx) => {
        const claim = await tx.emailVerificationToken.updateMany({
          where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (claim.count !== 1) return;
        claimed = true;
        await tx.user.update({ where: { id: record.userId }, data: { emailVerified: true } });
      });
      if (!claimed) return validationError(reply, { token: "This verification link is invalid or has expired." });
      return { ok: true };
    },
  );

  // Re-send the verification email for the signed-in user (no-op if already verified).
  app.post(
    "/api/auth/resend-verification",
    {
      config: {
        rateLimit: { max: Number(process.env.RESEND_VERIFICATION_RATE_LIMIT_MAX ?? 5), timeWindow: "1 minute" },
      },
    },
    async (request) => {
      const auth = await requireAuth(request);
      const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true, emailVerified: true } });
      if (!user || user.emailVerified) return { ok: true };
      await prisma.emailVerificationToken.updateMany({ where: { userId: auth.userId, usedAt: null }, data: { usedAt: new Date() } });
      const raw = createRawToken();
      await prisma.emailVerificationToken.create({
        data: { userId: auth.userId, tokenHash: hashToken(raw, env.tokenHashSecret), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) },
      });
      const verifyUrl = `${env.webOrigin}/verify-email?token=${encodeURIComponent(raw)}`;
      void getMailer()
        .sendEmailVerification(user.email, verifyUrl)
        .catch((error) => request.log.error(error, "failed to send verification email"));
      return { ok: true };
    },
  );

  // Which third-party sign-in providers are configured (lets the web show the right buttons).
  app.get("/api/auth/config", async () => ({ googleEnabled: getGoogleClient() !== null }));

  const OAUTH_COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.nodeEnv === "production",
    path: "/api/auth/google",
    maxAge: 600,
  };

  // Begin Google sign-in: stash state + PKCE verifier in short-lived cookies, redirect to Google.
  app.get("/api/auth/google/start", async (request, reply) => {
    const client = getGoogleClient();
    if (!client) return notFound(reply, "Google sign-in is not configured.");
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    reply.setCookie("pm_oauth_state", state, OAUTH_COOKIE_OPTIONS);
    reply.setCookie("pm_oauth_verifier", codeVerifier, OAUTH_COOKIE_OPTIONS);
    return reply.redirect(client.createAuthorizationURL(state, codeVerifier).toString());
  });

  // Google redirects back here: verify state, exchange the code, then link/create + sign in.
  app.get<{ Querystring: { code?: string; state?: string } }>("/api/auth/google/callback", async (request, reply) => {
    const client = getGoogleClient();
    if (!client) return notFound(reply, "Google sign-in is not configured.");
    const { code, state } = request.query;
    const cookieState = request.cookies.pm_oauth_state;
    const codeVerifier = request.cookies.pm_oauth_verifier;
    reply.clearCookie("pm_oauth_state", { path: "/api/auth/google" });
    reply.clearCookie("pm_oauth_verifier", { path: "/api/auth/google" });
    const fail = () => reply.redirect(`${env.webOrigin}/login?error=google`);
    if (!code || !state || !cookieState || !codeVerifier || state !== cookieState) return fail();

    let profile: GoogleProfile;
    try {
      profile = await client.profileFromCode(code, codeVerifier);
    } catch (error) {
      request.log.error(error, "google code exchange failed");
      return fail();
    }
    if (!profile.email) return fail();

    const userId = await resolveGoogleUser(profile);
    if (!userId) return fail();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
    await writeAuditEvent({
      userId,
      action: "google_sign_in",
      targetType: "user",
      targetId: userId,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    reply.setCookie(SESSION_COOKIE, sealSession(userId, user.sessionVersion, env.sessionSecret), COOKIE_OPTIONS);
    return reply.redirect(env.webOrigin);
  });

  app.get("/api/me", async (request) => {
    const auth = await requireAuth(request);
    return mePayload(auth.userId);
  });

  app.post<{
    Body: { name?: string; expiresAt?: string | null; kind?: string; scopes?: string[]; workspaceId?: string | null };
  }>("/api/tokens", async (request, reply) => {
    const auth = await requireAuth(request);
    const name = request.body.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "validation_error", fields: { name: "Name is required." } });
    }

    const expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return reply
        .code(400)
        .send({ error: "validation_error", fields: { expiresAt: "Expiry must be a valid date." } });
    }
    const kind = request.body.kind === "agent" ? "agent" : request.body.kind === "obsidian" ? "obsidian" : "personal";
    const requestedScopes = request.body.scopes ?? [...TOKEN_SCOPES];
    const invalidScope = requestedScopes.find((scope) => !isTokenScope(scope));
    if (invalidScope) {
      return reply.code(400).send({ error: "validation_error", fields: { scopes: `Unknown scope: ${invalidScope}` } });
    }
    const scopes = requestedScopes.length > 0 ? requestedScopes : ["read"];
    const workspaceId = request.body.workspaceId?.trim() || null;
    if (kind === "agent") {
      if (!workspaceId) {
        return reply.code(400).send({ error: "validation_error", fields: { workspaceId: "Workspace is required for agent tokens." } });
      }
      const membership = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
        select: { role: true },
      });
      if (!membership) return notFound(reply, "Workspace not found.");
    }

    const rawToken = createRawToken();
    const token = await prisma.apiToken.create({
      data: {
        userId: auth.userId,
        name,
        kind,
        scopes,
        workspaceId,
        tokenHash: hashToken(rawToken, env.tokenHashSecret),
        expiresAt,
      },
    });
    await writeAuditEvent({
      userId: auth.userId,
      action: "token_created",
      targetType: "api_token",
      targetId: token.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { name, kind, scopes, workspaceId },
    });

    return reply.code(201).send({
      id: token.id,
      name: token.name,
      kind: token.kind,
      scopes: token.scopes,
      workspaceId: token.workspaceId,
      token: rawToken,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
    });
  });

  app.get("/api/tokens", async (request) => {
    const auth = await requireAuth(request);
    const tokens = await prisma.apiToken.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
    });
    return {
      tokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        kind: token.kind,
        scopes: token.scopes,
        workspaceId: token.workspaceId,
        lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: token.lastUsedIp,
        expiresAt: token.expiresAt?.toISOString() ?? null,
        createdAt: token.createdAt.toISOString(),
        revokedAt: token.revokedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/tokens/:id/revoke", async (request, reply) => {
    const auth = await requireAuth(request);
    const token = await prisma.apiToken.findFirst({
      where: { id: request.params.id, userId: auth.userId },
    });
    if (!token) {
      return reply.code(404).send({ error: "not_found", message: "Token not found." });
    }
    if (!token.revokedAt) {
      await prisma.apiToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date() },
      });
      await writeAuditEvent({
        userId: auth.userId,
        action: "token_revoked",
        targetType: "api_token",
        targetId: token.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }
    return { ok: true };
  });
}
