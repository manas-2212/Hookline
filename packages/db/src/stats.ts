import { sql } from "kysely";
import type { Db } from "./client.js";

export interface Overview {
  queue: { pending: number; in_flight: number; failed_24h: number; succeeded_24h: number };
  per_minute: Array<{ minute: string; succeeded: number; failed: number }>;
  latency: { p50_ms: number | null; p95_ms: number | null; p99_ms: number | null };
  endpoints: { active: number; paused: number; disabled: number; degraded: number };
}

/** Numbers for the dashboard overview, scoped to one app. */
export async function overview(db: Db, appId: string): Promise<Overview> {
  const [queue, perMinute, latency, endpoints] = await Promise.all([
    sql<Overview["queue"]>`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'in_flight')::int AS in_flight,
             count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '24 hours')::int AS failed_24h,
             count(*) FILTER (WHERE status = 'succeeded' AND completed_at > now() - interval '24 hours')::int AS succeeded_24h
      FROM deliveries WHERE app_id = ${appId}`.execute(db),
    sql<{ minute: Date; succeeded: number; failed: number }>`
      SELECT gs.minute,
             coalesce(count(a.id) FILTER (WHERE a.response_status BETWEEN 200 AND 299), 0)::int AS succeeded,
             coalesce(count(a.id) FILTER (WHERE a.response_status IS NULL OR a.response_status NOT BETWEEN 200 AND 299), 0)::int AS failed
      FROM generate_series(date_trunc('minute', now()) - interval '59 minutes', date_trunc('minute', now()), interval '1 minute') AS gs(minute)
      LEFT JOIN attempts a ON a.app_id = ${appId} AND date_trunc('minute', a.started_at) = gs.minute
        AND a.started_at > now() - interval '61 minutes'
      GROUP BY gs.minute ORDER BY gs.minute`.execute(db),
    sql<Overview["latency"]>`
      SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS p50_ms,
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int AS p95_ms,
             (percentile_cont(0.99) WITHIN GROUP (ORDER BY ms))::int AS p99_ms
      FROM (SELECT extract(epoch FROM (first_attempt_at - created_at)) * 1000 AS ms
            FROM deliveries WHERE app_id = ${appId} AND first_attempt_at > now() - interval '1 hour') t`.execute(db),
    sql<Overview["endpoints"]>`
      SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*) FILTER (WHERE status = 'paused')::int AS paused,
             count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
             count(*) FILTER (WHERE status = 'active' AND consecutive_failures >= 5)::int AS degraded
      FROM endpoints WHERE app_id = ${appId}`.execute(db),
  ]);
  return {
    queue: queue.rows[0] ?? { pending: 0, in_flight: 0, failed_24h: 0, succeeded_24h: 0 },
    per_minute: perMinute.rows.map((r) => ({ minute: r.minute.toISOString(), succeeded: r.succeeded, failed: r.failed })),
    latency: latency.rows[0] ?? { p50_ms: null, p95_ms: null, p99_ms: null },
    endpoints: endpoints.rows[0] ?? { active: 0, paused: 0, disabled: 0, degraded: 0 },
  };
}

/** Global queue depth for Prometheus gauges (all apps). */
export async function queueDepth(db: Db): Promise<Record<string, number>> {
  const r = await sql<{ status: string; n: number }>`
    SELECT status, count(*)::int AS n FROM deliveries WHERE status IN ('pending', 'in_flight') GROUP BY status`.execute(db);
  const out: Record<string, number> = { pending: 0, in_flight: 0 };
  for (const row of r.rows) out[row.status] = row.n;
  return out;
}

export async function ping(db: Db): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

export interface RecentAttempt {
  id: string;
  endpoint_id: string;
  delivery_id: string;
  message_id: string;
  attempt_no: number;
  response_status: number | null;
  error_kind: string | null;
  duration_ms: number;
  started_at: Date;
  delivery_status: string;
}

/** Attempts in the last `seconds`, to seed the dashboard's live wire before SSE takes over. */
export async function recentAttempts(db: Db, appId: string, seconds: number): Promise<RecentAttempt[]> {
  const r = await sql<RecentAttempt>`
    SELECT a.id, a.endpoint_id, a.delivery_id, d.message_id, a.attempt_no, a.response_status, a.error_kind,
           a.duration_ms, a.started_at, d.status AS delivery_status
    FROM attempts a JOIN deliveries d ON d.id = a.delivery_id
    WHERE a.app_id = ${appId} AND a.started_at > now() - make_interval(secs => ${seconds})
    ORDER BY a.started_at DESC LIMIT 2000`.execute(db);
  return r.rows;
}
