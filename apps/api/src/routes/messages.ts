import { EVENT_TYPE_RE, MAX_PAYLOAD_BYTES, newTraceparent, parseTraceparent } from "@hookline/core";
import { decodeCursor, getDelivery, getMessage, ingestMessage, listAttempts, listDeliveriesForMessage, listMessages, retryDelivery } from "@hookline/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth, requireApp } from "../auth.js";
import type { Deps } from "../deps.js";
import { notFound, Problem } from "../errors.js";
import { messagesIngested } from "../metrics.js";

const MessageIn = z.object({
  event_type: z.string().regex(EVENT_TYPE_RE, "letters, digits, . _ - ; up to 128 chars"),
  payload: z.unknown().refine((v) => v !== undefined, "payload is required"),
});

const MessageOut = z.object({
  id: z.string(),
  event_type: z.string(),
  created_at: z.string(),
  deliveries: z.number().optional(),
});

export function messageRoutes(fastify: FastifyInstance, deps: Deps) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/v1/messages",
    {
      schema: {
        tags: ["messages"],
        summary: "Publish an event; fans out to every matching active endpoint",
        headers: z.object({ "idempotency-key": z.string().min(1).max(255).optional() }).passthrough(),
        body: MessageIn,
        response: { 200: MessageOut, 202: MessageOut },
      },
      preHandler: requireApp(deps, "owner"),
    },
    async (req, reply) => {
      const { appId } = auth(req);
      const rl = await deps.limiter.take(`ingest:${appId}`, deps.cfg.INGEST_RATE_PER_SEC, deps.cfg.INGEST_RATE_PER_SEC * 2);
      if (!rl.allowed) {
        reply.header("retry-after", Math.ceil(rl.retryAfterMs / 1000));
        throw new Problem(429, "Too Many Requests", "ingest rate limit exceeded");
      }
      const size = Buffer.byteLength(JSON.stringify(req.body.payload));
      if (size > MAX_PAYLOAD_BYTES) throw new Problem(413, "Payload Too Large", `payload is ${size} bytes; max ${MAX_PAYLOAD_BYTES}`);

      const incoming = req.headers.traceparent;
      const traceParent = parseTraceparent(typeof incoming === "string" ? incoming : null) ? (incoming as string) : newTraceparent();
      const result = await ingestMessage(
        deps.db,
        {
          appId,
          eventType: req.body.event_type,
          payload: req.body.payload,
          idempotencyKey: req.headers["idempotency-key"] ?? null,
          traceParent,
        },
        { afterInsert: deps.hooks?.afterMessageInsert },
      );
      if (result.kind === "conflict") {
        throw new Problem(409, "Conflict", "idempotency key was already used with a different request body");
      }
      const m = result.message;
      const body = { id: m.id, event_type: m.event_type, created_at: m.created_at.toISOString() };
      if (result.kind === "duplicate") return reply.status(200).header("idempotent-replayed", "true").send(body);
      messagesIngested.inc();
      return reply.status(202).send({ ...body, deliveries: result.deliveries });
    },
  );

  app.get(
    "/v1/messages",
    {
      schema: {
        tags: ["messages"],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
          event_type: z.string().optional(),
          endpoint_id: z.string().uuid().optional(),
          since: z.coerce.date().optional(),
          until: z.coerce.date().optional(),
        }),
      },
      preHandler: requireApp(deps),
    },
    async (req) => {
      const { appId } = auth(req);
      const q = req.query;
      return listMessages(deps.db, appId, {
        limit: q.limit,
        cursor: decodeCursor(q.cursor),
        eventType: q.event_type,
        endpointId: q.endpoint_id,
        since: q.since,
        until: q.until,
      });
    },
  );

  app.get("/v1/messages/:id", { schema: { tags: ["messages"], params: z.object({ id: z.string() }) }, preHandler: requireApp(deps) }, async (req) => {
    const { appId } = auth(req);
    const m = await getMessage(deps.db, appId, req.params.id);
    if (!m) throw notFound("message");
    const deliveries = await listDeliveriesForMessage(deps.db, appId, m.id);
    return {
      id: m.id,
      event_type: m.event_type,
      payload: m.payload,
      payload_bytes: m.payload_bytes,
      idempotency_key: m.idempotency_key,
      created_at: m.created_at,
      deliveries,
    };
  });

  app.get(
    "/v1/messages/:id/deliveries",
    { schema: { tags: ["deliveries"], params: z.object({ id: z.string() }) }, preHandler: requireApp(deps) },
    async (req) => {
      const { appId } = auth(req);
      const m = await getMessage(deps.db, appId, req.params.id);
      if (!m) throw notFound("message");
      return { items: await listDeliveriesForMessage(deps.db, appId, m.id) };
    },
  );

  app.get(
    "/v1/deliveries/:id/attempts",
    { schema: { tags: ["deliveries"], params: z.object({ id: z.string().uuid() }) }, preHandler: requireApp(deps) },
    async (req) => {
      const { appId } = auth(req);
      const d = await getDelivery(deps.db, appId, req.params.id);
      if (!d) throw notFound("delivery");
      return { delivery: d, items: await listAttempts(deps.db, appId, d.id) };
    },
  );

  app.post(
    "/v1/deliveries/:id/retry",
    {
      schema: { tags: ["deliveries"], summary: "Re-queue a finished delivery now (starts a new retry cycle)", params: z.object({ id: z.string().uuid() }) },
      preHandler: requireApp(deps, "owner"),
    },
    async (req, reply) => {
      const { appId } = auth(req);
      const d = await retryDelivery(deps.db, appId, req.params.id);
      if (!d) {
        const exists = await getDelivery(deps.db, appId, req.params.id);
        if (!exists) throw notFound("delivery");
        throw new Problem(409, "Conflict", `delivery is ${exists.status}; only finished deliveries can be retried`);
      }
      return reply.status(202).send({ id: d.id, status: d.status });
    },
  );
}
