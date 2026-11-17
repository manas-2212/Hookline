/** Thin fetch wrapper: cookie session + the selected app in a header (which is also the CSRF guard). */

let currentApp: string | null = null;
export const setCurrentApp = (id: string | null) => {
  currentApp = id;
};
export const getCurrentApp = () => currentApp;

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-hookline-csrf": "1" };
  if (currentApp) headers["x-hookline-app"] = currentApp;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { detail?: string; title?: string }).detail ?? (json as { title?: string }).title ?? res.statusText);
  return json as T;
}

export interface Me {
  user: { id: string; login: string; avatar_url: string | null };
  apps: Array<{ id: string; name: string; role: "owner" | "viewer" }>;
}

export interface Endpoint {
  id: string;
  kind: "http" | "relay";
  url: string | null;
  description: string | null;
  event_types: string[] | null;
  rate_limit_per_sec: number | null;
  status: "active" | "paused" | "disabled";
  disabled_reason: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  attempts_24h: number;
  succeeded_24h: number;
  pending: number;
  p50_ms_24h: number | null;
}

export interface MessageSummary {
  id: string;
  event_type: string;
  payload_bytes: number;
  created_at: string;
  delivered: number;
  failed: number;
  pending: number;
}

export interface Delivery {
  id: string;
  endpoint_id: string;
  endpoint_url: string | null;
  endpoint_kind: "http" | "relay";
  endpoint_description: string | null;
  status: "pending" | "in_flight" | "succeeded" | "failed" | "cancelled";
  attempt_count: number;
  next_attempt_at: string;
  first_attempt_at: string | null;
  completed_at: string | null;
}

export interface Attempt {
  id: string;
  attempt_no: number;
  transport: string;
  started_at: string;
  duration_ms: number;
  response_status: number | null;
  response_snippet: string | null;
  error_kind: string | null;
  error_detail: string | null;
}

export interface Overview {
  queue: { pending: number; in_flight: number; failed_24h: number; succeeded_24h: number };
  per_minute: Array<{ minute: string; succeeded: number; failed: number }>;
  latency: { p50_ms: number | null; p95_ms: number | null; p99_ms: number | null };
  endpoints: { active: number; paused: number; disabled: number; degraded: number };
}

export interface WireEvent {
  key: string;
  endpoint_id: string;
  message_id: string;
  attempt_no: number;
  response_status: number | null;
  error_kind: string | null;
  duration_ms: number;
  at: number;
  /** delivery status after this attempt: succeeded / pending (retry) / failed */
  outcome: string;
}

export const endpointLabel = (e: Pick<Endpoint, "kind" | "url" | "description">) => {
  if (e.description) return e.description;
  if (e.kind === "relay") return "CLI relay";
  try {
    const u = new URL(e.url ?? "");
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return e.url ?? "endpoint";
  }
};
