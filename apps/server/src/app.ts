import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { registerRoutes } from "./routes.js";
import { csrfGuard } from "./csrf.js";
import { registerLiveRoutes } from "./live/routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: ["loopback", "uniquelocal"] });

  await app.register(cors, { origin: env.webOrigin, credentials: true });
  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_MAX ?? 100), timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Pageden API",
        description:
          "REST API used by the Pageden web app, Obsidian plugin, public sharing, and developer integrations. The MCP endpoint remains the recommended interface for AI agents.",
        version: "0.1.0",
      },
      servers: [{ url: "/", description: "Same-origin Pageden server" }],
      tags: [
        { name: "System", description: "Health and readiness checks." },
        { name: "Auth", description: "Authentication, account, and token routes." },
        { name: "Workspaces", description: "Workspace and administration routes." },
        { name: "Documents", description: "Document tree, search, read, write, history, and export routes." },
        { name: "Folders", description: "Folder creation, movement, permissions, and deletion routes." },
        { name: "Public sharing", description: "Public document and folder manual routes." },
        { name: "Integrations", description: "AI agent and external integration routes." },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Pageden token" },
          sessionCookie: { type: "apiKey", in: "cookie", name: "pageden_session" },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/api-docs",
    staticCSP: true,
    uiConfig: {
      deepLinking: true,
      docExpansion: "list",
    },
  });
  await registerLiveRoutes(app);

  // CSRF: validate Origin/Referer for unsafe, cookie-authenticated browser requests.
  app.addHook("onRequest", csrfGuard);

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 401) {
      return reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
    }
    app.log.error(error);
    return reply.code(statusCode).send({ error: "server_error", message: "Something went wrong." });
  });

  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
      },
    },
    async () => app.swagger()
  );

  // Liveness
  app.get(
    "/api/health",
    {
      schema: {
        tags: ["System"],
        summary: "Liveness check",
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
          },
        },
      },
    },
    async () => ({ status: "ok" })
  );

  // Readiness — checks DB connectivity
  app.get(
    "/api/ready",
    {
      schema: {
        tags: ["System"],
        summary: "Readiness check",
        response: {
          200: {
            type: "object",
            required: ["status", "db"],
            properties: {
              status: { type: "string", enum: ["ready"] },
              db: { type: "string", enum: ["ok"] },
            },
          },
          503: {
            type: "object",
            required: ["status", "db"],
            properties: {
              status: { type: "string", enum: ["unavailable"] },
              db: { type: "string", enum: ["down"] },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: "ready", db: "ok" };
      } catch {
        return reply.code(503).send({ status: "unavailable", db: "down" });
      }
    }
  );

  await registerRoutes(app);

  return app;
}
