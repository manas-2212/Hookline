/**
 * @hookline/sdk — a small client for producers and a verifier for receivers.
 *
 *   const hookline = new Hookline({ apiKey: process.env.HOOKLINE_API_KEY });
 *   await hookline.messages.send("invoice.paid", { id: "inv_1" }, { idempotencyKey: "inv_1" });
 *
 *   // in your webhook handler (use the RAW body string, not re-serialized JSON):
 *   const { id } = verify(req.headers, rawBody, process.env.HOOKLINE_SECRET);
 */
export { type VerifyOptions, verify, WebhookVerificationError } from "@hookline/core";

export interface HooklineOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class HooklineError extends Error {
  constructor(
    public status: number,
    public problem: { title?: string; detail?: string; [k: string]: unknown },
  ) {
    super(`${status} ${problem.title ?? "error"}${problem.detail ? `: ${problem.detail}` : ""}`);
  }
}

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

export class Hookline {
  readonly baseUrl: string;
  private apiKey: string;
  private f: typeof fetch;

  constructor(o: HooklineOptions) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { title?: string; detail?: string };
    if (!res.ok) throw new HooklineError(res.status, json);
    return json;
  }

  messages = {
    send: (eventType: string, payload: unknown, o: { idempotencyKey?: string } = {}) =>
      this.request<{ id: string; event_type: string; created_at: string; deliveries?: number }>(
        "POST",
        "/v1/messages",
        { event_type: eventType, payload },
        o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {},
      ),
    get: (id: string) => this.request<Record<string, unknown>>("GET", `/v1/messages/${encodeURIComponent(id)}`),
    list: (q: { limit?: number; cursor?: string; event_type?: string } = {}) =>
      this.request<{ items: Array<Record<string, unknown>>; next: string | null }>("GET", `/v1/messages?${qs(q)}`),
  };

  endpoints = {
    create: (e: { url?: string; kind?: "http" | "relay"; description?: string; event_types?: string[]; rate_limit_per_sec?: number }) =>
      this.request<{ id: string; secret: string; url: string | null; kind: string }>("POST", "/v1/endpoints", { kind: "http", ...e }),
    list: () => this.request<{ items: Array<Record<string, unknown>> }>("GET", "/v1/endpoints"),
    update: (id: string, patch: Record<string, unknown>) => this.request<Record<string, unknown>>("PATCH", `/v1/endpoints/${id}`, patch),
    delete: (id: string) => this.request<void>("DELETE", `/v1/endpoints/${id}`),
    rotateSecret: (id: string) => this.request<{ secret: string }>("POST", `/v1/endpoints/${id}/rotate-secret`),
    test: (id: string) => this.request<{ message_id: string }>("POST", `/v1/endpoints/${id}/test`),
    replay: (id: string, r: { since: Date | string; until?: Date | string; only_failed?: boolean }) =>
      this.request<{ queued: number }>("POST", `/v1/endpoints/${id}/replay`, r),
  };

  deliveries = {
    attempts: (id: string) => this.request<{ items: Array<Record<string, unknown>> }>("GET", `/v1/deliveries/${id}/attempts`),
    retry: (id: string) => this.request<{ id: string }>("POST", `/v1/deliveries/${id}/retry`),
  };

  /** Stream live events (Server-Sent Events). Resolves when the stream ends or `signal` aborts. */
  async live(onEvent: (e: LiveEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.f(`${this.baseUrl}/v1/live`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new HooklineError(res.status, { title: "live stream failed" });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data && !frame.startsWith("event: ready")) {
          try {
            onEvent(JSON.parse(data) as LiveEvent);
          } catch {
            /* ignore */
          }
        }
        i = buf.indexOf("\n\n");
      }
    }
  }
}

function qs(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}
