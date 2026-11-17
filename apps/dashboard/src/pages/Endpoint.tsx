import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../App";
import { ApiError, api, type Endpoint, endpointLabel, type MessageSummary } from "../api";
import { Health, Status, Time, Toast, useToast } from "../components/bits";

const RANGES = [
  ["1h", 3_600_000, "the last hour"],
  ["24h", 86_400_000, "the last 24 hours"],
  ["7d", 7 * 86_400_000, "the last 7 days"],
] as const;

export function EndpointPage() {
  const { id = "" } = useParams();
  const { app, canWrite } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [toast, say] = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number][0]>("1h");
  const [onlyFailed, setOnlyFailed] = useState(true);

  // List data includes 24 h health, so read the endpoint from there.
  const eps = useQuery({ queryKey: ["endpoints", app.id], queryFn: () => api<{ items: Endpoint[] }>("GET", "/v1/endpoints") });
  const msgs = useQuery({
    queryKey: ["messages", app.id, "endpoint", id],
    queryFn: () => api<{ items: MessageSummary[] }>("GET", `/v1/messages?limit=15&endpoint_id=${id}`),
  });
  const e = eps.data?.items.find((x) => x.id === id);
  if (eps.isLoading) return <p className="muted">Loading…</p>;
  if (!e) return <p>This endpoint does not exist in {app.name}.</p>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      say(done);
      qc.invalidateQueries({ queryKey: ["endpoints"] });
    } catch (x) {
      say(x instanceof ApiError ? x.detail : "That did not work");
    }
  };
  const replay = () => {
    const r = RANGES.find(([k]) => k === range) ?? RANGES[0];
    return act(async () => {
      const res = await api<{ queued: number }>("POST", `/v1/endpoints/${id}/replay`, {
        since: new Date(Date.now() - r[1]).toISOString(),
        only_failed: onlyFailed,
      });
      say(`Queued ${res.queued} deliveries`);
    }, "Replay queued");
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/endpoints">Endpoints</Link>
          </p>
          <h1>{endpointLabel(e)}</h1>
        </div>
        {canWrite && (
          <div className="row">
            {e.status === "active" && (
              <>
                <button type="button" className="btn" onClick={() => act(() => api("POST", `/v1/endpoints/${id}/test`), "Test event sent")}>
                  Send test event
                </button>
                <button type="button" className="btn" onClick={() => act(() => api("PATCH", `/v1/endpoints/${id}`, { status: "paused" }), "Endpoint paused")}>
                  Pause
                </button>
              </>
            )}
            {e.status !== "active" && (
              <button
                type="button"
                className="btn primary"
                onClick={() => act(() => api("PATCH", `/v1/endpoints/${id}`, { status: "active" }), "Endpoint resumed")}
              >
                {e.status === "paused" ? "Resume" : "Re-enable"}
              </button>
            )}
          </div>
        )}
      </div>

      {e.status === "disabled" && (
        <p className="notice err">
          {e.disabled_reason === "gone"
            ? "Disabled because the endpoint answered 410 Gone, which means it asked to stop receiving webhooks."
            : "Disabled because every attempt failed for 5 days. Fix the receiver, then re-enable it and replay what it missed."}
        </p>
      )}

      <dl className="props">
        <dt>Delivers to</dt>
        <dd className="mono">{e.kind === "relay" ? "a connected hookline listen session" : e.url}</dd>
        <dt>Status</dt>
        <dd>
          <Status value={e.status} />
          {e.consecutive_failures >= 5 && e.status === "active" && (
            <span className="muted"> {e.consecutive_failures} failures in a row, so it is sent one request at a time until it recovers.</span>
          )}
        </dd>
        <dt>Events</dt>
        <dd>
          {e.event_types
            ? e.event_types.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))
            : "all event types"}
        </dd>
        <dt>Rate limit</dt>
        <dd>{e.rate_limit_per_sec ? `${e.rate_limit_per_sec} requests per second` : "none"}</dd>
        <dt>Success, 24 h</dt>
        <dd>
          <Health ok={e.succeeded_24h} total={e.attempts_24h} />{" "}
          <span className="muted small">
            {e.succeeded_24h} of {e.attempts_24h} attempts
          </span>
        </dd>
        <dt>Last success</dt>
        <dd>
          <Time iso={e.last_success_at} />
        </dd>
        <dt>Endpoint id</dt>
        <dd className="mono">{e.id}</dd>
      </dl>

      {canWrite && (
        <section>
          <div className="section-head">
            <h2>Replay</h2>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            Send messages again. Messages published before this endpoint existed are included, so a new endpoint can catch up.
          </p>
          <div className="row">
            <label>
              From
              <select value={range} onChange={(ev) => setRange(ev.target.value as typeof range)}>
                {RANGES.map(([k, , label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
              <input type="checkbox" checked={onlyFailed} onChange={(ev) => setOnlyFailed(ev.target.checked)} />
              Only messages that failed
            </label>
            <button type="button" className="btn" onClick={replay}>
              Replay messages
            </button>
          </div>
        </section>
      )}

      {canWrite && (
        <section>
          <div className="section-head">
            <h2>Signing secret</h2>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            Rotating creates a new secret. The old one keeps signing alongside it for 24 hours, so the receiver can switch without dropping requests.
          </p>
          {secret && (
            <p className="notice secret">
              New secret, shown once: <code>{secret}</code>
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                act(async () => {
                  const r = await api<{ secret: string }>("POST", `/v1/endpoints/${id}/rotate-secret`);
                  setSecret(r.secret);
                }, "Secret rotated")
              }
            >
              Rotate secret
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                if (!window.confirm("Delete this endpoint and its delivery history? This cannot be undone.")) return;
                void act(() => api("DELETE", `/v1/endpoints/${id}`), "Endpoint deleted").then(() => navigate("/endpoints"));
              }}
            >
              Delete endpoint
            </button>
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Recent messages</h2>
          <Link to={`/messages?endpoint=${id}`}>All messages to this endpoint</Link>
        </div>
        <MessageRows items={msgs.data?.items ?? []} />
      </section>
      <Toast text={toast} />
    </>
  );
}

export function MessageRows({ items }: { items: MessageSummary[] }) {
  const navigate = useNavigate();
  if (items.length === 0) return <p className="muted">No messages yet.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Message</th>
          <th>Event</th>
          <th>Deliveries</th>
          <th>Sent</th>
        </tr>
      </thead>
      <tbody>
        {items.map((m) => (
          <tr key={m.id} className="click" onClick={() => navigate(`/messages/${m.id}`)}>
            <td>
              <Link to={`/messages/${m.id}`} className="mono" onClick={(ev) => ev.stopPropagation()}>
                {m.id}
              </Link>
            </td>
            <td>
              <span className="tag">{m.event_type}</span>
            </td>
            <td>
              {m.delivered > 0 && <Status value="succeeded" label={`${m.delivered} delivered`} />}{" "}
              {m.pending > 0 && <Status value="pending" label={`${m.pending} waiting`} />}{" "}
              {m.failed > 0 && <Status value="failed" label={`${m.failed} failed`} />}
              {m.delivered + m.pending + m.failed === 0 && <span className="muted">no matching endpoints</span>}
            </td>
            <td>
              <Time iso={m.created_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
