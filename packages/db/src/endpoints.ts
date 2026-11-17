import { decrypt, encrypt, generateSecret } from "@hookline/core";
import { sql } from "kysely";
import type { Db } from "./client.js";
import type { Endpoint, EndpointKind, EndpointStatus } from "./schema.js";

export const ROTATION_OVERLAP_HOURS = 24;

export async function createEndpoint(
  db: Db,
  key: Buffer,
  e: {
    appId: string;
    kind: EndpointKind;
    url: string | null;
    description: string | null;
    eventTypes: string[] | null;
    rateLimitPerSec: number | null;
  },
): Promise<{ endpoint: Endpoint; secret: string }> {
  const secret = generateSecret();
  const endpoint = await db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto("endpoints")
      .values({
        app_id: e.appId,
        kind: e.kind,
        url: e.url,
        description: e.description,
        event_types: e.eventTypes,
        rate_limit_per_sec: e.rateLimitPerSec,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("endpoint_secrets")
      .values({ endpoint_id: row.id, secret_enc: encrypt(secret, key) })
      .execute();
    return row;
  });
  return { endpoint, secret };
}

export async function getEndpoint(db: Db, appId: string, id: string): Promise<Endpoint | undefined> {
  return db.selectFrom("endpoints").selectAll().where("id", "=", id).where("app_id", "=", appId).executeTakeFirst();
}

export interface EndpointWithHealth extends Endpoint {
  attempts_24h: number;
  succeeded_24h: number;
  pending: number;
  p50_ms_24h: number | null;
}

export async function listEndpoints(db: Db, appId: string): Promise<EndpointWithHealth[]> {
  const r = await sql<EndpointWithHealth>`
    SELECT e.*,
      coalesce(a.attempts, 0)::int AS attempts_24h,
      coalesce(a.succeeded, 0)::int AS succeeded_24h,
      a.p50_ms::int AS p50_ms_24h,
      (SELECT count(*) FROM deliveries d WHERE d.endpoint_id = e.id AND d.status IN ('pending', 'in_flight'))::int AS pending
    FROM endpoints e
    LEFT JOIN LATERAL (
      SELECT count(*) AS attempts,
             count(*) FILTER (WHERE response_status BETWEEN 200 AND 299) AS succeeded,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms
      FROM attempts at WHERE at.endpoint_id = e.id AND at.started_at > now() - interval '24 hours'
    ) a ON true
    WHERE e.app_id = ${appId}
    ORDER BY e.created_at DESC`.execute(db);
  return r.rows;
}

export async function updateEndpoint(
  db: Db,
  appId: string,
  id: string,
  patch: {
    url?: string;
    description?: string | null;
    eventTypes?: string[] | null;
    rateLimitPerSec?: number | null;
    status?: Exclude<EndpointStatus, "disabled">;
  },
): Promise<Endpoint | undefined> {
  const set: Record<string, unknown> = { updated_at: sql`now()` };
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.eventTypes !== undefined) set.event_types = patch.eventTypes;
  if (patch.rateLimitPerSec !== undefined) set.rate_limit_per_sec = patch.rateLimitPerSec;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.disabled_reason = null;
    if (patch.status === "active") set.consecutive_failures = 0; // re-enabling resets the breaker
  }
  return db.updateTable("endpoints").set(set).where("id", "=", id).where("app_id", "=", appId).returningAll().executeTakeFirst();
}

export async function deleteEndpoint(db: Db, appId: string, id: string): Promise<boolean> {
  const r = await db.deleteFrom("endpoints").where("id", "=", id).where("app_id", "=", appId).executeTakeFirst();
  return Number(r.numDeletedRows) === 1;
}

/** New secret now; the old one keeps signing (dual signatures) for the overlap window. */
export async function rotateSecret(db: Db, key: Buffer, appId: string, id: string): Promise<string | undefined> {
  const secret = generateSecret();
  const ok = await db.transaction().execute(async (tx) => {
    const ep = await tx.selectFrom("endpoints").select("id").where("id", "=", id).where("app_id", "=", appId).executeTakeFirst();
    if (!ep) return false;
    await tx
      .updateTable("endpoint_secrets")
      .set({ expires_at: sql`now() + make_interval(hours => ${ROTATION_OVERLAP_HOURS})` })
      .where("endpoint_id", "=", id)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now() + make_interval(hours => ${ROTATION_OVERLAP_HOURS})`)]))
      .execute();
    await tx
      .insertInto("endpoint_secrets")
      .values({ endpoint_id: id, secret_enc: encrypt(secret, key) })
      .execute();
    return true;
  });
  return ok ? secret : undefined;
}

/** Decrypted, currently valid secrets, newest first. */
export async function activeSecrets(db: Db, key: Buffer, endpointId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("endpoint_secrets")
    .select("secret_enc")
    .where("endpoint_id", "=", endpointId)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => decrypt(r.secret_enc, key));
}
