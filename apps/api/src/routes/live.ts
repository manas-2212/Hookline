import type { LiveEvent } from "@hookline/db";
import type { FastifyInstance } from "fastify";
import { auth, requireApp } from "../auth.js";
import type { Deps } from "../deps.js";
import { liveClients } from "../metrics.js";

/**
 * Server-Sent Events stream of everything happening in an app: messages arriving, attempts
 * finishing, endpoints being disabled. Fed by Postgres LISTEN/NOTIFY, so it works across any
 * number of API and worker replicas without a separate broker.
 */
export function liveRoutes(fastify: FastifyInstance, deps: Deps) {
  fastify.get(
    "/v1/live",
    { schema: { tags: ["live"], summary: "SSE stream of live delivery events" }, preHandler: requireApp(deps, "viewer", { appFromQuery: true }) },
    async (req, reply) => {
      const { appId } = auth(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`event: ready\ndata: {"app_id":"${appId}"}\n\n`);
      liveClients.inc({ kind: "sse" });

      const unsubscribe = await deps.hub.subscribe((e: LiveEvent) => {
        if (e.app_id !== appId) return;
        res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.raw.on("close", () => {
        clearInterval(ping);
        unsubscribe();
        liveClients.dec({ kind: "sse" });
      });
    },
  );
}
