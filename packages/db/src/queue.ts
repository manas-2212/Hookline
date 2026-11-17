import { DEGRADE_AFTER_FAILURES, type Decision } from "@hookline/core";
import { sql, type Transaction } from "kysely";
import type { Db } from "./client.js";
import { EVENTS_CHANNEL, type LiveEvent } from "./client.js";
import type { Database, Delivery } from "./schema.js";

/**
 * The delivery queue. Postgres is the queue (ADR 0001): a delivery row is claimed by moving it
 * from 'pending' to 'in_flight' under a lease, and every state change is guarded by the
 * claiming worker's id so a worker whose lease expired can't overwrite someone else's claim.
 */

export interface ClaimOptions {
  workerId: string;
  batchSize: number;
  leaseSeconds: number;
  /** Max deliveries in flight per endpoint while healthy. Degraded endpoints get 1. */
  maxInFlightPerEndpoint: number;
  /** Max distinct endpoints considered per claim (bounds the cost of one claim). */
  maxEndpoints?: number;
  /** Restrict to one endpoint (relay sessions claim for their own endpoint only). */
  endpointId?: string;
  kind?: "http" | "relay";
}

/**
 * Fair claim. Instead of "oldest N due rows" (which lets one flooded endpoint fill every batch
 * and starve everyone else), it:
 *   1. picks endpoints that have due work, in random order;
 *   2. gives each endpoint only its free slots (cap minus what is already in flight);
 *   3. locks the chosen rows with FOR UPDATE SKIP LOCKED so concurrent workers never block on,
 *      or double-claim, the same row.
 * The per-endpoint cap is soft: two workers claiming at the same instant can each see the same
 * in-flight count, so an endpoint can briefly exceed its cap by up to (workers - 1) × slots.
 */
export async function claimDue(db: Db, o: ClaimOptions): Promise<Delivery[]> {
  const kind = o.kind ?? "http";
  const endpointFilter = o.endpointId ? sql`AND e.id = ${o.endpointId}` : sql``;
  const result = await sql<Delivery>`
    WITH due_endpoints AS (
      SELECT e.id,
             (CASE WHEN e.consecutive_failures >= ${DEGRADE_AFTER_FAILURES} THEN 1 ELSE ${o.maxInFlightPerEndpoint} END)
             - (SELECT count(*) FROM deliveries f WHERE f.endpoint_id = e.id AND f.status = 'in_flight') AS slots
      FROM endpoints e
      WHERE e.status = 'active' AND e.kind = ${kind} ${endpointFilter}
        AND EXISTS (SELECT 1 FROM deliveries p
                    WHERE p.endpoint_id = e.id AND p.status = 'pending' AND p.next_attempt_at <= now())
      ORDER BY random()
      LIMIT ${o.maxEndpoints ?? 200}
    ),
    picked AS (
      SELECT c.id
      FROM due_endpoints de
      CROSS JOIN LATERAL (
        SELECT d.id FROM deliveries d
        WHERE d.endpoint_id = de.id AND d.status = 'pending' AND d.next_attempt_at <= now()
        ORDER BY d.next_attempt_at
        LIMIT greatest(de.slots, 0)
        FOR UPDATE SKIP LOCKED
      ) c
      LIMIT ${o.batchSize}
    )
    UPDATE deliveries d
    SET status = 'in_flight',
        locked_by = ${o.workerId},
        locked_until = now() + make_interval(secs => ${o.leaseSeconds}),
        updated_at = now()
    FROM picked
    WHERE d.id = picked.id
    RETURNING d.*`.execute(db);
  return result.rows;
}

export interface DeliveryContext {
  delivery_id: string;
  attempt_count: number;
  retry_base: number;
  message_id: string;
  event_type: string;
  payload_text: string;
  trace_parent: string | null;
  message_created_at: Date;
  endpoint_id: string;
  endpoint_kind: "http" | "relay";
  endpoint_url: string | null;
  endpoint_status: "active" | "paused" | "disabled";
  rate_limit_per_sec: number | null;
  app_id: string;
  secrets_enc: Buffer[];
}

/** Everything needed to send claimed deliveries, in one round trip. */
export async function loadContexts(db: Db, deliveryIds: string[]): Promise<DeliveryContext[]> {
  if (deliveryIds.length === 0) return [];
  const r = await sql<DeliveryContext>`
    SELECT d.id AS delivery_id, d.attempt_count, d.retry_base,
           m.id AS message_id, m.event_type, m.payload::text AS payload_text, m.trace_parent,
           m.created_at AS message_created_at,
           e.id AS endpoint_id, e.kind AS endpoint_kind, e.url AS endpoint_url, e.status AS endpoint_status,
           e.rate_limit_per_sec, d.app_id,
           coalesce((SELECT array_agg(s.secret_enc ORDER BY s.created_at DESC) FROM endpoint_secrets s
                     WHERE s.endpoint_id = e.id AND (s.expires_at IS NULL OR s.expires_at > now())), '{}') AS secrets_enc
    FROM deliveries d
    JOIN messages m ON m.id = d.message_id
    JOIN endpoints e ON e.id = d.endpoint_id
    WHERE d.id = ANY(${deliveryIds}::uuid[])`.execute(db);
  return r.rows;
}

export interface AttemptRecord {
  transport: "http" | "relay";
  startedAt: Date;
  durationMs: number;
  responseStatus: number | null;
  responseSnippet: string | null;
  errorKind: string | null;
  errorDetail: string | null;
}

export type CompleteResult = { applied: true; attemptNo: number; status: Delivery["status"] } | { applied: false; reason: "lost_lease" };

/**
 * Record one attempt and move the delivery to its next state, atomically. The UPDATE is guarded
 * by `locked_by = workerId AND status = 'in_flight'`: if the lease expired and the reaper (or
 * another worker) took the row, nothing is written and the caller learns it lost the lease.
 */
export async function completeAttempt(
  db: Db,
  args: { deliveryId: string; workerId: string; record: AttemptRecord; decision: Decision },
): Promise<CompleteResult> {
  const { deliveryId, workerId, record, decision } = args;
  return db.transaction().execute(async (tx) => {
    const status: Delivery["status"] = decision.kind === "retry" ? "pending" : decision.kind === "succeeded" ? "succeeded" : "failed";
    const nextAt = decision.kind === "retry" ? sql`now() + make_interval(secs => ${decision.delayMs / 1000})` : sql`next_attempt_at`;
    const done = status !== "pending";
    const updated = await sql<{ attempt_count: number; endpoint_id: string; app_id: string; message_id: string }>`
      UPDATE deliveries
      SET status = ${status},
          attempt_count = attempt_count + 1,
          next_attempt_at = ${nextAt},
          first_attempt_at = coalesce(first_attempt_at, ${record.startedAt}),
          completed_at = ${done ? sql`now()` : sql`NULL`},
          locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = ${deliveryId} AND locked_by = ${workerId} AND status = 'in_flight'
      RETURNING attempt_count, endpoint_id, app_id, message_id`.execute(tx);
    const row = updated.rows[0];
    if (!row) return { applied: false, reason: "lost_lease" } as const;

    await tx
      .insertInto("attempts")
      .values({
        delivery_id: deliveryId,
        app_id: row.app_id,
        endpoint_id: row.endpoint_id,
        attempt_no: row.attempt_count,
        transport: record.transport,
        started_at: record.startedAt,
        duration_ms: record.durationMs,
        response_status: record.responseStatus,
        response_snippet: record.responseSnippet,
        error_kind: record.errorKind,
        error_detail: record.errorDetail,
      })
      .execute();

    if (decision.kind === "succeeded") {
      await tx
        .updateTable("endpoints")
        .set({ consecutive_failures: 0, last_success_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", row.endpoint_id)
        .execute();
    } else {
      await tx
        .updateTable("endpoints")
        .set({ consecutive_failures: sql`consecutive_failures + 1`, last_failure_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", row.endpoint_id)
        .execute();
    }
    if (decision.kind === "endpoint_gone") {
      await disableEndpointTx(tx, row.endpoint_id, row.app_id, "gone");
    }

    await notify(tx, {
      kind: "attempt",
      app_id: row.app_id,
      endpoint_id: row.endpoint_id,
      delivery_id: deliveryId,
      message_id: row.message_id,
      status,
      response_status: record.responseStatus,
      duration_ms: record.durationMs,
      error_kind: record.errorKind,
      attempt_no: row.attempt_count,
      at: new Date().toISOString(),
    });
    return { applied: true, attemptNo: row.attempt_count, status } as const;
  });
}

/** Give a claimed delivery back without counting an attempt (rate limited, endpoint paused). */
export async function releaseClaim(db: Db, deliveryId: string, workerId: string, delayMs: number): Promise<boolean> {
  const r = await db
    .updateTable("deliveries")
    .set({
      status: "pending",
      next_attempt_at: sql`now() + make_interval(secs => ${delayMs / 1000})`,
      locked_by: null,
      locked_until: null,
      updated_at: sql`now()`,
    })
    .where("id", "=", deliveryId)
    .where("locked_by", "=", workerId)
    .where("status", "=", "in_flight")
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/** Return expired leases to the queue. This is what makes a crashed worker harmless. */
export async function reapExpired(db: Db): Promise<number> {
  const r = await db
    .updateTable("deliveries")
    .set({ status: "pending", locked_by: null, locked_until: null, next_attempt_at: sql`now()`, updated_at: sql`now()` })
    .where("status", "=", "in_flight")
    .where("locked_until", "<", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

async function disableEndpointTx(tx: Transaction<Database>, endpointId: string, appId: string, reason: string): Promise<void> {
  await tx.updateTable("endpoints").set({ status: "disabled", disabled_reason: reason, updated_at: sql`now()` }).where("id", "=", endpointId).execute();
  await tx
    .updateTable("deliveries")
    .set({ status: "cancelled", completed_at: sql`now()`, updated_at: sql`now()` })
    .where("endpoint_id", "=", endpointId)
    .where("status", "=", "pending")
    .execute();
  await notify(tx, { kind: "endpoint", app_id: appId, endpoint_id: endpointId, status: `disabled:${reason}`, at: new Date().toISOString() });
}

export async function disableEndpoint(db: Db, endpointId: string, appId: string, reason: string): Promise<void> {
  await db.transaction().execute((tx) => disableEndpointTx(tx, endpointId, appId, reason));
}

/** Circuit breaker, open state: disable endpoints that have failed continuously for `afterMs`. */
export async function disableLongFailing(db: Db, afterMs: number): Promise<Array<{ id: string; app_id: string }>> {
  const victims = await db
    .selectFrom("endpoints")
    .select(["id", "app_id"])
    .where("status", "=", "active")
    .where("consecutive_failures", ">=", DEGRADE_AFTER_FAILURES)
    .where(sql<boolean>`coalesce(last_success_at, created_at) < now() - make_interval(secs => ${afterMs / 1000})`)
    .execute();
  for (const v of victims) await disableEndpoint(db, v.id, v.app_id, "failing");
  return victims;
}

/** Manual retry of one finished delivery: starts a fresh retry cycle. */
export async function retryDelivery(db: Db, appId: string, deliveryId: string): Promise<Delivery | undefined> {
  return db
    .updateTable("deliveries")
    .set({
      status: "pending",
      next_attempt_at: sql`now()`,
      retry_base: sql`attempt_count`,
      completed_at: null,
      updated_at: sql`now()`,
    })
    .where("id", "=", deliveryId)
    .where("app_id", "=", appId)
    .where("status", "in", ["failed", "cancelled", "succeeded"])
    .returningAll()
    .executeTakeFirst();
}

/**
 * Replay messages in a time range to one endpoint. Messages that never had a delivery for this
 * endpoint (e.g. sent before it existed) get one; finished deliveries start a new cycle.
 */
export async function replay(db: Db, args: { appId: string; endpointId: string; since: Date; until: Date; onlyFailed: boolean }): Promise<number> {
  const statusFilter = args.onlyFailed ? sql`AND deliveries.status IN ('failed', 'cancelled')` : sql`AND deliveries.status NOT IN ('pending', 'in_flight')`;
  const r = await sql`
    INSERT INTO deliveries (message_id, endpoint_id, app_id)
    SELECT m.id, e.id, m.app_id
    FROM messages m
    JOIN endpoints e ON e.id = ${args.endpointId} AND e.app_id = m.app_id
    WHERE m.app_id = ${args.appId}
      AND m.created_at >= ${args.since} AND m.created_at < ${args.until}
      AND (e.event_types IS NULL OR m.event_type = ANY(e.event_types))
    ON CONFLICT (message_id, endpoint_id) DO UPDATE
      SET status = 'pending', next_attempt_at = now(), retry_base = deliveries.attempt_count,
          completed_at = NULL, updated_at = now()
      WHERE true ${statusFilter}`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

/** Delete old messages (cascading to deliveries and attempts) in small batches. */
export async function deleteExpired(db: Db, olderThanDays: number, batch = 1000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await sql`
      DELETE FROM messages WHERE id IN (
        SELECT m.id FROM messages m
        WHERE m.created_at < now() - make_interval(days => ${olderThanDays})
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.status IN ('pending', 'in_flight'))
        LIMIT ${batch})`.execute(db);
    const n = Number(r.numAffectedRows ?? 0);
    total += n;
    if (n < batch) return total;
  }
}

export async function notify(executor: Db | Transaction<Database>, event: LiveEvent): Promise<void> {
  await sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`.execute(executor);
}
