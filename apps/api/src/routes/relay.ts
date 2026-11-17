import { randomUUID } from "node:crypto";
import { decideForDelivery, decrypt, RESPONSE_SNIPPET_BYTES, signatureHeaders, snippet } from "@hookline/core";
import { claimDue, completeAttempt, type DeliveryContext, getEndpoint, loadContexts, releaseClaim } from "@hookline/db";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { auth, requireApp } from "../auth.js";
import type { Deps } from "../deps.js";
import { liveClients } from "../metrics.js";

/**
 * Relay transport behind `hookline listen`: a CLI on a developer's laptop opens a WebSocket,
 * and deliveries for a `relay` endpoint are pushed down that socket instead of over HTTP. The
 * CLI forwards each one to localhost and reports the result. Deliveries use the same claim
 * query, lease, retry policy and attempt log as the HTTP worker; only the transport differs.
 */

const ClientMsg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("result"),
    delivery_id: z.string().uuid(),
    status: z.number().int().nullable(),
    duration_ms: z.number().int().min(0),
    body: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);

const MAX_OUTSTANDING = 4;
const POLL_MS = 250;

export function relayRoutes(fastify: FastifyInstance, deps: Deps) {
  fastify.get(
    "/v1/relay/:endpointId",
    {
      websocket: true,
      schema: { tags: ["relay"], summary: "WebSocket used by `hookline listen`" },
      preHandler: requireApp(deps, "owner"),
    },
    async (socket: WebSocket, req) => {
      const { appId } = auth(req);
      const endpointId = (req.params as { endpointId: string }).endpointId;
      const endpoint = z.string().uuid().safeParse(endpointId).success ? await getEndpoint(deps.db, appId, endpointId) : undefined;
      if (endpoint?.kind !== "relay") {
        socket.send(JSON.stringify({ type: "error", message: "relay endpoint not found" }));
        socket.close(4404, "not found");
        return;
      }
      const workerId = `relay:${randomUUID().slice(0, 8)}`;
      const outstanding = new Map<string, { ctx: DeliveryContext; startedAt: Date; timer: NodeJS.Timeout }>();
      let closed = false;
      liveClients.inc({ kind: "relay" });
      socket.send(JSON.stringify({ type: "hello", endpoint_id: endpoint.id, session: workerId }));

      const finish = async (deliveryId: string, r: { status: number | null; durationMs: number; body: string | null; error: string | null }) => {
        const o = outstanding.get(deliveryId);
        if (!o) return;
        outstanding.delete(deliveryId);
        clearTimeout(o.timer);
        const ok = r.status !== null && r.status >= 200 && r.status < 300;
        const errorKind = r.error ? (r.error === "timeout" ? "timeout" : "connect") : ok ? null : "http_status";
        const decision = decideForDelivery(o.ctx, { ok, status: r.status, errorKind });
        await completeAttempt(deps.db, {
          deliveryId,
          workerId,
          decision,
          record: {
            transport: "relay",
            startedAt: o.startedAt,
            durationMs: r.durationMs,
            responseStatus: r.status,
            responseSnippet: snippet(r.body, RESPONSE_SNIPPET_BYTES),
            errorKind,
            errorDetail: r.error,
          },
        });
      };

      const pump = async () => {
        if (closed || outstanding.size >= MAX_OUTSTANDING) return;
        const claimed = await claimDue(deps.db, {
          workerId,
          kind: "relay",
          endpointId: endpoint.id,
          batchSize: MAX_OUTSTANDING - outstanding.size,
          leaseSeconds: deps.cfg.LEASE_SECONDS,
          maxInFlightPerEndpoint: MAX_OUTSTANDING,
        });
        if (claimed.length === 0) return;
        for (const ctx of await loadContexts(
          deps.db,
          claimed.map((d) => d.id),
        )) {
          const secrets = ctx.secrets_enc.map((b) => decrypt(b, deps.encKey));
          const headers = {
            "content-type": "application/json",
            ...signatureHeaders(secrets, ctx.message_id, Math.floor(Date.now() / 1000), ctx.payload_text),
          };
          const timer = setTimeout(() => {
            void finish(ctx.delivery_id, { status: null, durationMs: deps.cfg.REQUEST_TIMEOUT_MS, body: null, error: "timeout" });
          }, deps.cfg.REQUEST_TIMEOUT_MS);
          outstanding.set(ctx.delivery_id, { ctx, startedAt: new Date(), timer });
          socket.send(
            JSON.stringify({
              type: "delivery",
              delivery_id: ctx.delivery_id,
              attempt_no: ctx.attempt_count + 1,
              event_type: ctx.event_type,
              headers,
              body: ctx.payload_text,
            }),
          );
        }
      };

      let pumping = false;
      const poll = setInterval(() => {
        if (pumping) return;
        pumping = true;
        pump()
          .catch((err) => req.log.error({ err }, "relay pump failed"))
          .finally(() => {
            pumping = false;
          });
      }, POLL_MS);

      socket.on("message", (data) => {
        const parsed = ClientMsg.safeParse(JSON.parse(String(data)));
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "ping") return socket.send(JSON.stringify({ type: "pong" }));
        void finish(m.delivery_id, { status: m.status, durationMs: m.duration_ms, body: m.body ?? null, error: m.error ?? null }).catch((err) =>
          req.log.error({ err }, "relay result failed"),
        );
      });

      socket.on("close", () => {
        closed = true;
        clearInterval(poll);
        liveClients.dec({ kind: "relay" });
        // Hand unanswered deliveries straight back to the queue rather than waiting for the reaper.
        for (const [id, o] of outstanding) {
          clearTimeout(o.timer);
          void releaseClaim(deps.db, id, workerId, 0);
        }
        outstanding.clear();
      });
    },
  );
}
