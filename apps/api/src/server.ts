import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import { ping } from "@hookline/db";
import Fastify, { type FastifyInstance } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Deps } from "./deps.js";
import { errorHandler, Problem } from "./errors.js";
import { httpDuration, registry } from "./metrics.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { liveRoutes } from "./routes/live.js";
import { messageRoutes } from "./routes/messages.js";
import { relayRoutes } from "./routes/relay.js";
import { sessionRoutes } from "./routes/session.js";

const DASHBOARD_DIST = join(dirname(fileURLToPath(import.meta.url)), "../../dashboard/dist");

export async function buildServer(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: deps.cfg.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 512 * 1024,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorateRequest("auth", null);

  await app.register(cookie, { secret: deps.cfg.SESSION_SECRET });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Hookline API", version: "1.0.0", description: "Reliable, signed webhook delivery." },
      components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer" } } },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ ok: true }));
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) => {
    const ok = await ping(deps.db);
    return reply.status(ok ? 200 : 503).send({ ok });
  });
  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));

  messageRoutes(app, deps);
  endpointRoutes(app, deps);
  sessionRoutes(app, deps);
  liveRoutes(app, deps);
  relayRoutes(app, deps);

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // Serve the built dashboard (single origin keeps cookie auth simple) with SPA fallback.
  if (existsSync(DASHBOARD_DIST)) {
    await app.register(fastifyStatic, { root: DASHBOARD_DIST });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      // Client-side routes get index.html; a missing file (anything with an extension) is a real 404.
      const isAppRoute = !path.startsWith("/v1/") && !path.startsWith("/auth/") && !/\.[a-z0-9]+$/i.test(path);
      if (req.method === "GET" && isAppRoute) {
        return reply.sendFile("index.html");
      }
      return errorHandler(new Problem(404, "Not Found", `route ${req.method} ${req.url} not found`), req, reply);
    });
  } else {
    app.setNotFoundHandler((req, reply) => errorHandler(new Problem(404, "Not Found", `route ${req.method} ${req.url} not found`), req, reply));
  }
  return app;
}
