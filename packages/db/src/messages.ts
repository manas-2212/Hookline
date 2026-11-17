import { newMessageId, requestHash } from "@hookline/core";
import { sql } from "kysely";
import type { Db } from "./client.js";
import { notify } from "./queue.js";
import type { Message } from "./schema.js";

export type IngestResult = { kind: "created"; message: Message; deliveries: number } | { kind: "duplicate"; message: Message } | { kind: "conflict" };

/**
 * Insert a message and fan it out to every active matching endpoint in ONE transaction:
 * if this returns "created", the deliveries exist. `afterInsert` is a test hook used to prove
 * that a failure mid-transaction leaves nothing behind.
 */
export async function ingestMessage(
  db: Db,
  m: {
    appId: string;
    eventType: string;
    payload: unknown;
    idempotencyKey: string | null;
    traceParent?: string | null;
    /** Deliver to this endpoint only, ignoring its event filter (test events). */
    targetEndpointId?: string;
  },
  hooks: { afterInsert?: () => void | Promise<void> } = {},
): Promise<IngestResult> {
  const hash = requestHash(m.eventType, m.payload);
  if (m.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, m.appId, m.idempotencyKey);
    if (existing) return existing.request_hash?.equals(hash) ? { kind: "duplicate", message: existing } : { kind: "conflict" };
  }
  const body = JSON.stringify(m.payload);
  try {
    return await db.transaction().execute(async (tx) => {
      const message = await tx
        .insertInto("messages")
        .values({
          id: newMessageId(),
          app_id: m.appId,
          event_type: m.eventType,
          payload: body,
          payload_bytes: Buffer.byteLength(body),
          idempotency_key: m.idempotencyKey,
          request_hash: hash,
          trace_parent: m.traceParent ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await hooks.afterInsert?.();
      const match = m.targetEndpointId ? sql`e.id = ${m.targetEndpointId}` : sql`(e.event_types IS NULL OR ${m.eventType} = ANY(e.event_types))`;
      const fanned = await sql`
        INSERT INTO deliveries (message_id, endpoint_id, app_id)
        SELECT ${message.id}, e.id, e.app_id FROM endpoints e
        WHERE e.app_id = ${m.appId} AND e.status = 'active' AND ${match}`.execute(tx);
      const deliveries = Number(fanned.numAffectedRows ?? 0);
      await notify(tx, {
        kind: "message",
        app_id: m.appId,
        message_id: message.id,
        event_type: m.eventType,
        at: message.created_at.toISOString(),
      });
      return { kind: "created", message, deliveries } as const;
    });
  } catch (err) {
    // Two concurrent requests with the same key: the loser hits the unique index.
    if (m.idempotencyKey && (err as { code?: string }).code === "23505") {
      const existing = await findByIdempotencyKey(db, m.appId, m.idempotencyKey);
      if (existing) return existing.request_hash?.equals(hash) ? { kind: "duplicate", message: existing } : { kind: "conflict" };
    }
    throw err;
  }
}

async function findByIdempotencyKey(db: Db, appId: string, key: string): Promise<Message | undefined> {
  return db
    .selectFrom("messages")
    .selectAll()
    .where("app_id", "=", appId)
    .where("idempotency_key", "=", key)
    .where("created_at", ">", sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirst();
}

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString()) as Partial<Cursor>;
    return typeof v.createdAt === "string" && typeof v.id === "string" ? { createdAt: v.createdAt, id: v.id } : undefined;
  } catch {
    return undefined;
  }
}

export interface MessageSummary {
  id: string;
  event_type: string;
  payload_bytes: number;
  created_at: Date;
  delivered: number;
  failed: number;
  pending: number;
}

export async function listMessages(
  db: Db,
  appId: string,
  q: { limit: number; cursor?: Cursor; eventType?: string; since?: Date; until?: Date; endpointId?: string },
): Promise<{ items: MessageSummary[]; next: string | null }> {
  let query = db
    .selectFrom("messages as m")
    .select([
      "m.id",
      "m.event_type",
      "m.payload_bytes",
      "m.created_at",
      sql<number>`(SELECT count(*) FROM deliveries d WHERE d.message_id = m.id AND d.status = 'succeeded')::int`.as("delivered"),
      sql<number>`(SELECT count(*) FROM deliveries d WHERE d.message_id = m.id AND d.status IN ('failed', 'cancelled'))::int`.as("failed"),
      sql<number>`(SELECT count(*) FROM deliveries d WHERE d.message_id = m.id AND d.status IN ('pending', 'in_flight'))::int`.as("pending"),
    ])
    .where("m.app_id", "=", appId);
  if (q.eventType) query = query.where("m.event_type", "=", q.eventType);
  if (q.since) query = query.where("m.created_at", ">=", q.since);
  if (q.until) query = query.where("m.created_at", "<", q.until);
  if (q.endpointId) {
    const ep = q.endpointId;
    query = query.where(({ exists, selectFrom }) =>
      exists(selectFrom("deliveries as d").select("d.id").whereRef("d.message_id", "=", "m.id").where("d.endpoint_id", "=", ep)),
    );
  }
  if (q.cursor) {
    const c = q.cursor;
    query = query.where(sql<boolean>`(m.created_at, m.id) < (${c.createdAt}::timestamptz, ${c.id})`);
  }
  const rows = await query
    .orderBy("m.created_at", "desc")
    .orderBy("m.id", "desc")
    .limit(q.limit + 1)
    .execute();
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  const next = rows.length > q.limit && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null;
  return { items, next };
}

export async function getMessage(db: Db, appId: string, id: string): Promise<Message | undefined> {
  return db.selectFrom("messages").selectAll().where("id", "=", id).where("app_id", "=", appId).executeTakeFirst();
}

export async function listDeliveriesForMessage(db: Db, appId: string, messageId: string) {
  return db
    .selectFrom("deliveries as d")
    .innerJoin("endpoints as e", "e.id", "d.endpoint_id")
    .select([
      "d.id",
      "d.endpoint_id",
      "e.url as endpoint_url",
      "e.kind as endpoint_kind",
      "e.description as endpoint_description",
      "d.status",
      "d.attempt_count",
      "d.next_attempt_at",
      "d.first_attempt_at",
      "d.completed_at",
      "d.created_at",
    ])
    .where("d.message_id", "=", messageId)
    .where("d.app_id", "=", appId)
    .orderBy("d.created_at")
    .execute();
}

export async function getDelivery(db: Db, appId: string, id: string) {
  return db.selectFrom("deliveries").selectAll().where("id", "=", id).where("app_id", "=", appId).executeTakeFirst();
}

export async function listAttempts(db: Db, appId: string, deliveryId: string) {
  return db.selectFrom("attempts").selectAll().where("delivery_id", "=", deliveryId).where("app_id", "=", appId).orderBy("attempt_no").execute();
}
