import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

// Return int8 (count(*)) as number; our counts stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = Kysely<Database>;

export function createDb(connectionString: string, opts: { max?: number } = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 20 });
  // An idle client can error (database restart, network blip). Without a listener that error
  // is an unhandled 'error' event and crashes the process; with one, the pool just drops it.
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "idle postgres client error", err: err.message })));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/** Channel used with LISTEN/NOTIFY to stream delivery events to dashboards and CLIs. */
export const EVENTS_CHANNEL = "hookline_events";

export interface LiveEvent {
  kind: "attempt" | "message" | "endpoint";
  app_id: string;
  endpoint_id?: string;
  delivery_id?: string;
  message_id?: string;
  event_type?: string;
  status?: string;
  response_status?: number | null;
  duration_ms?: number;
  error_kind?: string | null;
  attempt_no?: number;
  at: string;
}

/** Subscribe to live events on a dedicated connection. Returns an unsubscribe function. */
export async function listenEvents(pool: pg.Pool, onEvent: (e: LiveEvent) => void): Promise<() => Promise<void>> {
  const client = await pool.connect();
  client.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "LISTEN connection error", err: err.message })));
  client.on("notification", (msg) => {
    if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return;
    try {
      onEvent(JSON.parse(msg.payload) as LiveEvent);
    } catch {
      /* ignore malformed payloads */
    }
  });
  await client.query(`LISTEN ${EVENTS_CHANNEL}`);
  return async () => {
    await client.query(`UNLISTEN ${EVENTS_CHANNEL}`).catch(() => {});
    client.release();
  };
}
