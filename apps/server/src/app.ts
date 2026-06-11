import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
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
  await registerLiveRoutes(app);

  // CSRF: validate Origin/Referer for unsafe, cookie-authenticated browser requests.
  app.addHook("onRequest", csrfGuard);

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 401) {
      return reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
    }
    app.log.error(error);
    return reply.code(statusCode).send({ error: "server_error", message: "Something went wrong." });
  });

  // Liveness
  app.get("/api/health", async () => ({ status: "ok" }));

  // Readiness — checks DB connectivity
  app.get("/api/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready", db: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable", db: "down" });
    }
  });

  await registerRoutes(app);

  return app;
}
