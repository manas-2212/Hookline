import { useEffect, useRef, useState } from "react";
import { api, type WireEvent } from "./api";

interface Raw {
  kind: string;
  endpoint_id?: string;
  delivery_id?: string;
  message_id?: string;
  attempt_no?: number;
  response_status?: number | null;
  error_kind?: string | null;
  duration_ms?: number;
  status?: string;
  at: string;
}

/**
 * Live attempts for the selected app: seeded from /v1/attempts/recent, then kept current by
 * the SSE stream. `onChange` lets pages refresh their own queries when something happens.
 */
export function useLive(appId: string | null, onChange?: (kind: string) => void) {
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!appId) return;
    let closed = false;
    setEvents([]);
    api<{ items: Array<Raw & { id: string; started_at: string; delivery_status: string }> }>("GET", "/v1/attempts/recent?seconds=120")
      .then((r) => {
        if (closed) return;
        const seeded: WireEvent[] = r.items.map((a) => ({
          key: a.id,
          endpoint_id: a.endpoint_id ?? "",
          message_id: a.message_id ?? "",
          attempt_no: a.attempt_no ?? 1,
          response_status: a.response_status ?? null,
          error_kind: a.error_kind ?? null,
          duration_ms: a.duration_ms ?? 0,
          at: new Date(a.started_at).getTime(),
          // A seeded attempt that wasn't the last one on its delivery was followed by a retry.
          outcome: a.response_status && a.response_status < 300 ? "succeeded" : a.delivery_status === "failed" ? "failed" : "pending",
        }));
        setEvents((cur) => [...seeded, ...cur]);
      })
      .catch(() => {});

    const es = new EventSource(`/v1/live?app=${encodeURIComponent(appId)}`);
    es.addEventListener("ready", () => setConnected(true));
    es.onerror = () => setConnected(false);
    const onAttempt = (ev: MessageEvent<string>) => {
      const e = JSON.parse(ev.data) as Raw;
      setEvents((cur) => {
        const cutoff = Date.now() - 125_000;
        const next = cur.length > 3000 ? cur.filter((x) => x.at > cutoff) : cur;
        return [
          ...next,
          {
            key: `${e.delivery_id}:${e.attempt_no}`,
            endpoint_id: e.endpoint_id ?? "",
            message_id: e.message_id ?? "",
            attempt_no: e.attempt_no ?? 1,
            response_status: e.response_status ?? null,
            error_kind: e.error_kind ?? null,
            duration_ms: e.duration_ms ?? 0,
            at: Date.now(),
            outcome: e.status ?? "succeeded",
          },
        ];
      });
      cb.current?.("attempt");
    };
    es.addEventListener("attempt", onAttempt as EventListener);
    es.addEventListener("message", () => cb.current?.("message"));
    es.addEventListener("endpoint", () => cb.current?.("endpoint"));
    return () => {
      closed = true;
      es.close();
      setConnected(false);
    };
  }, [appId]);

  return { events, connected };
}
