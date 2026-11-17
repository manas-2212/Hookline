import { checkEndpointUrl, EVENT_TYPE_RE, parseAllowlist } from "@hookline/core";
import { createEndpoint, deleteEndpoint, getEndpoint, ingestMessage, listEndpoints, replay, rotateSecret, updateEndpoint } from "@hookline/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth, requireApp } from "../auth.js";
import type { Deps } from "../deps.js";
import { notFound, Problem } from "../errors.js";

const EventTypes = z.array(z.string().regex(EVENT_TYPE_RE)).min(1).max(100).nullable();

const CreateBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http").default("http"),
    url: z.string().min(1).max(2048),
    description: z.string().max(500).nullable().optional(),
    event_types: EventTypes.optional(),
    rate_limit_per_sec: z.number().int().min(1).max(10_000).nullable().optional(),
  }),
  z.object({
    kind: z.literal("relay"),
    description: z.string().max(500).nullable().optional(),
    event_types: EventTypes.optional(),
    rate_limit_per_sec: z.number().int().min(1).max(10_000).nullable().optional(),
  }),
]);

const PatchBody = z.object({
  url: z.string().min(1).max(2048).optional(),
  description: z.string().max(500).nullable().optional(),
  event_types: EventTypes.optional(),
  rate_limit_per_sec: z.number().int().min(1).max(10_000).nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

export function endpointRoutes(fastify: FastifyInstance, deps: Deps) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const allowlist = parseAllowlist(deps.cfg.ENDPOINT_ALLOWLIST);

  const validateUrl = (url: string) => {
    const r = checkEndpointUrl(url, { allowInsecure: deps.cfg.ALLOW_INSECURE_ENDPOINTS, allowlist });
    if (!r.ok) {
      const why = {
        invalid: "not a valid URL",
        scheme: deps.cfg.ALLOW_INSECURE_ENDPOINTS ? "must be http or https" : "must be https",
        credentials: "must not contain credentials",
        too_long: "too long",
        blocked_ip: "points at a private, loopback or reserved address",
      }[r.problem];
      throw new Problem(422, "Unprocessable Entity", `url ${why}`, { problem: r.problem });
    }
    return r.url.toString();
  };

  app.post(
    "/v1/endpoints",
    {
      schema: { tags: ["endpoints"], summary: "Create an endpoint; the signing secret is returned only here", body: CreateBody },
      preHandler: requireApp(deps, "owner"),
    },
    async (req, reply) => {
      const { appId } = auth(req);
      const b = req.body;
      const url = b.kind === "http" ? validateUrl(b.url) : null;
      const { endpoint, secret } = await createEndpoint(deps.db, deps.encKey, {
        appId,
        kind: b.kind,
        url,
        description: b.description ?? null,
        eventTypes: b.event_types ?? null,
        rateLimitPerSec: b.rate_limit_per_sec ?? null,
      });
      return reply.status(201).send({ ...endpoint, secret });
    },
  );

  app.get("/v1/endpoints", { schema: { tags: ["endpoints"] }, preHandler: requireApp(deps) }, async (req) => {
    const { appId } = auth(req);
    return { items: await listEndpoints(deps.db, appId) };
  });

  app.get("/v1/endpoints/:id", { schema: { tags: ["endpoints"], params: IdParams }, preHandler: requireApp(deps) }, async (req) => {
    const { appId } = auth(req);
    const e = await getEndpoint(deps.db, appId, req.params.id);
    if (!e) throw notFound("endpoint");
    return e;
  });

  app.patch("/v1/endpoints/:id", { schema: { tags: ["endpoints"], params: IdParams, body: PatchBody }, preHandler: requireApp(deps, "owner") }, async (req) => {
    const { appId } = auth(req);
    const existing = await getEndpoint(deps.db, appId, req.params.id);
    if (!existing) throw notFound("endpoint");
    const b = req.body;
    if (b.url !== undefined && existing.kind !== "http") throw new Problem(422, "Unprocessable Entity", "relay endpoints have no url");
    const updated = await updateEndpoint(deps.db, appId, req.params.id, {
      url: b.url !== undefined ? validateUrl(b.url) : undefined,
      description: b.description,
      eventTypes: b.event_types,
      rateLimitPerSec: b.rate_limit_per_sec,
      status: b.status,
    });
    if (!updated) throw notFound("endpoint");
    return updated;
  });

  app.delete("/v1/endpoints/:id", { schema: { tags: ["endpoints"], params: IdParams }, preHandler: requireApp(deps, "owner") }, async (req, reply) => {
    const { appId } = auth(req);
    if (!(await deleteEndpoint(deps.db, appId, req.params.id))) throw notFound("endpoint");
    return reply.status(204).send();
  });

  app.post(
    "/v1/endpoints/:id/rotate-secret",
    {
      schema: { tags: ["endpoints"], summary: "New secret; the old one stays valid (dual signatures) for 24 h", params: IdParams },
      preHandler: requireApp(deps, "owner"),
    },
    async (req) => {
      const { appId } = auth(req);
      const secret = await rotateSecret(deps.db, deps.encKey, appId, req.params.id);
      if (!secret) throw notFound("endpoint");
      return { secret, previous_valid_for_hours: 24 };
    },
  );

  app.post(
    "/v1/endpoints/:id/test",
    { schema: { tags: ["endpoints"], summary: "Send a hookline.test event to this endpoint only", params: IdParams }, preHandler: requireApp(deps, "owner") },
    async (req, reply) => {
      const { appId } = auth(req);
      const e = await getEndpoint(deps.db, appId, req.params.id);
      if (!e) throw notFound("endpoint");
      if (e.status !== "active") throw new Problem(409, "Conflict", `endpoint is ${e.status}`);
      const r = await ingestMessage(deps.db, {
        appId,
        eventType: "hookline.test",
        payload: { message: "Hello from Hookline", endpoint_id: e.id, sent_at: new Date().toISOString() },
        idempotencyKey: null,
        targetEndpointId: e.id,
      });
      if (r.kind !== "created") throw new Problem(500, "Internal Server Error");
      return reply.status(202).send({ message_id: r.message.id });
    },
  );

  app.post(
    "/v1/endpoints/:id/replay",
    {
      schema: {
        tags: ["endpoints"],
        summary: "Re-deliver messages from a time range (also back-fills messages sent before the endpoint existed)",
        params: IdParams,
        body: z.object({ since: z.coerce.date(), until: z.coerce.date().optional(), only_failed: z.boolean().default(false) }),
      },
      preHandler: requireApp(deps, "owner"),
    },
    async (req, reply) => {
      const { appId } = auth(req);
      const e = await getEndpoint(deps.db, appId, req.params.id);
      if (!e) throw notFound("endpoint");
      const until = req.body.until ?? new Date();
      if (until <= req.body.since) throw new Problem(422, "Unprocessable Entity", "until must be after since");
      const queued = await replay(deps.db, { appId, endpointId: e.id, since: req.body.since, until, onlyFailed: req.body.only_failed });
      return reply.status(202).send({ queued });
    },
  );
}
