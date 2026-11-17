import { randomUUID } from "node:crypto";
import { decideForDelivery, decrypt, RESPONSE_SNIPPET_BYTES, type Rng, signatureHeaders, snippet } from "@hookline/core";
import { claimDue, completeAttempt, type Db, type DeliveryContext, listenEvents, loadContexts, type Pool, releaseClaim } from "@hookline/db";
import type { RateLimiter } from "@hookline/ratelimit";
import { currentTraceparent, linkFromTraceparent, tracer } from "@hookline/telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Logger } from "pino";
import { attemptDuration, attemptsTotal, deliveryLatency, lostLeases } from "./metrics.js";
import type { HttpTransport, SendResult } from "./transport.js";

export interface WorkerOptions {
  concurrency: number;
  batchSize: number;
  leaseSeconds: number;
  maxInFlightPerEndpoint: number;
  /** Multiplies every retry delay. 1 in production; tests shrink it to run the full schedule fast. */
  retryDelayScale?: number;
  idleMaxMs?: number;
}

export interface WorkerDeps {
  db: Db;
  pool: Pool;
  transport: Pick<HttpTransport, "send">;
  limiter: RateLimiter;
  encKey: Buffer;
  log: Logger;
  rng?: Rng;
  workerId?: string;
}

/**
 * The delivery loop. Keeps up to `concurrency` deliveries in flight: whenever slots are free it
 * claims a fair batch (see claimDue), sends each delivery, and records the outcome. When the queue
 * is empty it sleeps, but wakes immediately when Postgres NOTIFYs that a message arrived.
 */
export class DeliveryWorker {
  readonly id: string;
  private running = false;
  private inFlight = 0;
  private wake: (() => void) | null = null;
  private stopListening: (() => Promise<void>) | null = null;
  private loopDone: Promise<void> | null = null;
  private active = new Set<Promise<void>>();

  constructor(
    private deps: WorkerDeps,
    private o: WorkerOptions,
  ) {
    this.id = deps.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  }

  async start(): Promise<void> {
    this.running = true;
    this.stopListening = await listenEvents(this.deps.pool, (e) => {
      if (e.kind === "message") this.wake?.();
    });
    this.loopDone = this.loop();
  }

  /** Graceful stop: no new claims; waits for in-flight sends to finish and be recorded. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopDone;
    await Promise.allSettled([...this.active]);
    // Idempotent: a second stop() must not release the LISTEN connection twice.
    const unlisten = this.stopListening;
    this.stopListening = null;
    await unlisten?.();
  }

  private async loop(): Promise<void> {
    let idle = 25;
    while (this.running) {
      const free = this.o.concurrency - this.inFlight;
      let claimed = 0;
      if (free > 0) {
        try {
          const rows = await claimDue(this.deps.db, {
            workerId: this.id,
            batchSize: Math.min(free, this.o.batchSize),
            leaseSeconds: this.o.leaseSeconds,
            maxInFlightPerEndpoint: this.o.maxInFlightPerEndpoint,
          });
          claimed = rows.length;
          if (claimed > 0) {
            const contexts = await loadContexts(
              this.deps.db,
              rows.map((r) => r.id),
            );
            for (const ctx of contexts) this.spawn(ctx);
          }
        } catch (err) {
          this.deps.log.error({ err }, "claim failed");
        }
      }
      if (claimed > 0 && this.inFlight < this.o.concurrency) {
        idle = 25;
        continue;
      }
      idle = claimed > 0 ? 25 : Math.min(idle * 2, this.o.idleMaxMs ?? 1000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, free > 0 ? idle : 50);
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.wake = done;
      });
      this.wake = null;
    }
  }

  private spawn(ctx: DeliveryContext) {
    this.inFlight++;
    const p = this.process(ctx)
      .catch((err) => this.deps.log.error({ err, delivery_id: ctx.delivery_id }, "delivery processing failed"))
      .finally(() => {
        this.inFlight--;
        this.active.delete(p);
        this.wake?.();
      });
    this.active.add(p);
  }

  async process(ctx: DeliveryContext): Promise<void> {
    const { db, limiter, log } = this.deps;
    if (ctx.endpoint_status !== "active" || !ctx.endpoint_url) {
      // Paused between claim and send: hand it back without spending an attempt.
      await releaseClaim(db, ctx.delivery_id, this.id, 30_000);
      return;
    }
    if (ctx.rate_limit_per_sec) {
      const t = await limiter.take(`ep:${ctx.endpoint_id}`, ctx.rate_limit_per_sec, ctx.rate_limit_per_sec);
      if (!t.allowed) {
        await releaseClaim(db, ctx.delivery_id, this.id, t.retryAfterMs);
        return;
      }
    }

    await tracer.startActiveSpan(
      "hookline.deliver",
      {
        links: linkFromTraceparent(ctx.trace_parent),
        attributes: {
          "hookline.message_id": ctx.message_id,
          "hookline.delivery_id": ctx.delivery_id,
          "hookline.endpoint_id": ctx.endpoint_id,
          "hookline.attempt": ctx.attempt_count + 1,
        },
      },
      async (span) => {
        const startedAt = new Date();
        const secrets = ctx.secrets_enc.map((b) => decrypt(b, this.deps.encKey));
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "Hookline/1.0",
          "hookline-attempt": String(ctx.attempt_count + 1),
          "hookline-event-type": ctx.event_type,
          ...signatureHeaders(secrets, ctx.message_id, Math.floor(startedAt.getTime() / 1000), ctx.payload_text),
        };
        const tp = currentTraceparent();
        if (tp) headers.traceparent = tp;

        // endpoint_url is non-null here: checked at the top of process().
        const r: SendResult = await this.deps.transport.send(ctx.endpoint_url as string, headers, ctx.payload_text);
        const decision = decideForDelivery(ctx, r, this.deps.rng, r.retryAfterMs);
        const scaled = decision.kind === "retry" ? { ...decision, delayMs: decision.delayMs * (this.o.retryDelayScale ?? 1) } : decision;

        const result = await completeAttempt(db, {
          deliveryId: ctx.delivery_id,
          workerId: this.id,
          decision: scaled,
          record: {
            transport: "http",
            startedAt,
            durationMs: r.durationMs,
            responseStatus: r.status,
            responseSnippet: snippet(r.body, RESPONSE_SNIPPET_BYTES),
            errorKind: r.errorKind,
            errorDetail: r.errorDetail,
          },
        });

        const outcome = r.ok ? "success" : "failure";
        attemptsTotal.inc({ outcome, error_kind: r.errorKind ?? "none" });
        attemptDuration.observe({ outcome }, r.durationMs / 1000);
        if (ctx.attempt_count === 0) deliveryLatency.observe((startedAt.getTime() - ctx.message_created_at.getTime()) / 1000);
        span.setAttribute("http.response.status_code", r.status ?? 0);
        if (!r.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: r.errorKind ?? "failed" });
        if (!result.applied) {
          lostLeases.inc();
          log.warn({ delivery_id: ctx.delivery_id }, "lease lost before completion; attempt not recorded (at-least-once)");
        } else {
          log.debug(
            { delivery_id: ctx.delivery_id, endpoint_id: ctx.endpoint_id, attempt: result.attemptNo, status: r.status, ms: r.durationMs, next: scaled.kind },
            "attempt",
          );
        }
        span.end();
      },
    );
  }
}
