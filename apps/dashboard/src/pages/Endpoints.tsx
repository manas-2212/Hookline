import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../App";
import { ApiError, api, type Endpoint, endpointLabel } from "../api";
import { fmt, Health, Status, Time } from "../components/bits";

export function EndpointsPage() {
  const { app, canWrite } = useApp();
  const qc = useQueryClient();
  const eps = useQuery({ queryKey: ["endpoints", app.id], queryFn: () => api<{ items: Endpoint[] }>("GET", "/v1/endpoints") });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [rate, setRate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<{ id: string; secret: string }>("POST", "/v1/endpoints", {
        kind: "http",
        url: url.trim(),
        event_types: events.trim()
          ? events
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
        rate_limit_per_sec: rate ? Number(rate) : null,
      });
      setCreated(r);
      setAdding(false);
      setUrl("");
      setEvents("");
      setRate("");
      qc.invalidateQueries({ queryKey: ["endpoints"] });
    } catch (x) {
      setErr(x instanceof ApiError ? x.detail : "Could not add the endpoint");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Endpoints</h1>
          <p>Where your webhooks go. Each endpoint has its own signing secret, filters and rate limit.</p>
        </div>
        {canWrite && !adding && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            Add endpoint
          </button>
        )}
      </div>

      {created && (
        <div className="notice secret">
          <p>
            Endpoint added. Copy its signing secret now; it is not shown again.
            <br />
            <code>{created.secret}</code>
          </p>
          <p className="small muted" style={{ marginTop: 6 }}>
            Verify each request with this secret using the <code>webhook-signature</code> header (Standard Webhooks).{" "}
            <Link to={`/endpoints/${created.id}`}>Open the endpoint</Link>
          </p>
        </div>
      )}

      {adding && (
        <form className="form" onSubmit={add} style={{ marginBottom: 28 }}>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.customer.com/webhooks" required />
          </label>
          <label>
            Event types (comma separated; leave empty for all)
            <input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="invoice.paid, invoice.failed" />
          </label>
          <label>
            Rate limit, requests per second (optional)
            <input value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="unlimited" />
          </label>
          {err && <p className="notice err">{err}</p>}
          <div className="row">
            <button className="btn primary" type="submit">
              Add endpoint
            </button>
            <button className="btn" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {eps.data && eps.data.items.length === 0 && !adding && (
        <p className="muted">
          No endpoints yet. Add an HTTPS URL, or run <code>hookline listen --forward-to http://localhost:3000/webhooks</code> to receive webhooks on your
          laptop.
        </p>
      )}

      {eps.data && eps.data.items.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Events</th>
              <th>Status</th>
              <th>Success, 24 h</th>
              <th className="num">Waiting</th>
              <th>Last success</th>
            </tr>
          </thead>
          <tbody>
            {eps.data.items.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/endpoints/${e.id}`}>{endpointLabel(e)}</Link>
                  <div className="small muted mono">{e.kind === "relay" ? "relay to a hookline listen session" : e.url}</div>
                </td>
                <td>
                  {e.event_types ? (
                    e.event_types.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))
                  ) : (
                    <span className="muted">all</span>
                  )}
                </td>
                <td>{e.status === "active" && e.consecutive_failures >= 5 ? <Status value="degraded" label="degraded" /> : <Status value={e.status} />}</td>
                <td>
                  <Health ok={e.succeeded_24h} total={e.attempts_24h} />
                </td>
                <td className="num">{fmt(e.pending)}</td>
                <td>
                  <Time iso={e.last_success_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
