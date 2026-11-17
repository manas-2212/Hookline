import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useApp } from "../App";
import { api, type Endpoint, endpointLabel, type Overview } from "../api";
import { fmt, Health, MinuteBars, Status, Time } from "../components/bits";
import { LiveWire } from "../components/LiveWire";

export function OverviewPage() {
  const { app, live } = useApp();
  const ov = useQuery({ queryKey: ["overview", app.id], queryFn: () => api<Overview>("GET", "/v1/stats/overview"), refetchInterval: 15_000 });
  const eps = useQuery({ queryKey: ["endpoints", app.id], queryFn: () => api<{ items: Endpoint[] }>("GET", "/v1/endpoints") });
  const o = ov.data;
  const endpoints = eps.data?.items ?? [];
  const attention = endpoints.filter((e) => e.status === "disabled" || e.consecutive_failures >= 5);

  return (
    <>
      <div className="page-head">
        <h1>{app.name}</h1>
      </div>

      <LiveWire endpoints={endpoints} events={live.events} connected={live.connected} />

      {o && (
        <section>
          <p className="summary">
            In the last 24 hours <strong className="ok">{fmt(o.queue.succeeded_24h)}</strong> deliveries arrived and{" "}
            <strong className={o.queue.failed_24h ? "fail" : undefined}>{fmt(o.queue.failed_24h)}</strong> gave up after every retry.{" "}
            {o.queue.pending + o.queue.in_flight > 0 ? (
              <>
                <strong>{fmt(o.queue.pending + o.queue.in_flight)}</strong> are waiting or being sent now.{" "}
              </>
            ) : (
              "Nothing is waiting. "
            )}
            {o.latency.p50_ms !== null && (
              <>
                Over the last hour, a new message reached its first attempt in <strong>{fmt(o.latency.p50_ms)} ms</strong> at the median and{" "}
                <strong>{fmt(o.latency.p95_ms ?? 0)} ms</strong> at p95.
              </>
            )}
          </p>
          <div style={{ marginTop: 18 }}>
            <MinuteBars data={o.per_minute} />
          </div>
        </section>
      )}

      {attention.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Needs attention</h2>
          </div>
          <table className="table">
            <tbody>
              {attention.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/endpoints/${e.id}`}>{endpointLabel(e)}</Link>
                  </td>
                  <td>
                    {e.status === "disabled" ? (
                      <Status value="disabled" label={e.disabled_reason === "gone" ? "disabled: answered 410 Gone" : "disabled after failing for 5 days"} />
                    ) : (
                      <Status value="degraded" label={`${e.consecutive_failures} failures in a row; sending one at a time`} />
                    )}
                  </td>
                  <td className="muted">
                    last success <Time iso={e.last_success_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Endpoints</h2>
          <Link to="/endpoints">Manage endpoints</Link>
        </div>
        {endpoints.length === 0 ? (
          <p className="muted">
            No endpoints yet. <Link to="/endpoints">Add one</Link> to start delivering.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Success, 24 h</th>
                <th className="num">Waiting</th>
                <th className="num">Median response</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/endpoints/${e.id}`}>{endpointLabel(e)}</Link>
                  </td>
                  <td>{e.status === "active" && e.consecutive_failures >= 5 ? <Status value="degraded" label="degraded" /> : <Status value={e.status} />}</td>
                  <td>
                    <Health ok={e.succeeded_24h} total={e.attempts_24h} />
                  </td>
                  <td className="num">{fmt(e.pending)}</td>
                  <td className="num">{e.p50_ms_24h !== null ? `${fmt(e.p50_ms_24h)} ms` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
