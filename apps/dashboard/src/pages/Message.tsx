import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../App";
import { ApiError, type Attempt, api, type Delivery, endpointLabel } from "../api";
import { Json, Status, Time, Toast, useToast } from "../components/bits";

interface MessageDetail {
  id: string;
  event_type: string;
  payload: unknown;
  payload_bytes: number;
  idempotency_key: string | null;
  created_at: string;
  deliveries: Delivery[];
}

export function MessagePage() {
  const { id = "" } = useParams();
  const { app } = useApp();
  const m = useQuery({ queryKey: ["message", app.id, id], queryFn: () => api<MessageDetail>("GET", `/v1/messages/${id}`) });
  if (m.isLoading) return <p className="muted">Loading…</p>;
  if (!m.data) return <p>This message does not exist in {app.name}.</p>;
  const d = m.data;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/messages">Messages</Link>
          </p>
          <h1 className="mono" style={{ fontSize: "1.375rem" }}>
            {d.id}
          </h1>
          <p>
            <span className="tag">{d.event_type}</span> published <Time iso={d.created_at} />, {d.payload_bytes.toLocaleString()} bytes
            {d.idempotency_key && (
              <>
                , idempotency key <code>{d.idempotency_key}</code>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="split">
        <section>
          <div className="section-head">
            <h2>Payload</h2>
          </div>
          <Json value={d.payload} />
        </section>
        <section style={{ marginTop: 0 }}>
          <div className="section-head">
            <h2>Deliveries</h2>
          </div>
          {d.deliveries.length === 0 && <p className="muted">No endpoint matched this event type when it was published.</p>}
          {d.deliveries.map((x) => (
            <DeliveryBlock key={x.id} d={x} />
          ))}
        </section>
      </div>
    </>
  );
}

function DeliveryBlock({ d }: { d: Delivery }) {
  const { app, canWrite } = useApp();
  const qc = useQueryClient();
  const [toast, say] = useToast();
  const attempts = useQuery({
    queryKey: ["attempts", app.id, d.id, d.attempt_count, d.status],
    queryFn: () => api<{ items: Attempt[] }>("GET", `/v1/deliveries/${d.id}/attempts`),
  });
  const retry = async () => {
    try {
      await api("POST", `/v1/deliveries/${d.id}/retry`);
      say("Retry queued");
      qc.invalidateQueries({ queryKey: ["message"] });
    } catch (x) {
      say(x instanceof ApiError ? x.detail : "Could not retry");
    }
  };
  const finished = d.status === "failed" || d.status === "cancelled" || d.status === "succeeded";
  return (
    <div className="delivery">
      <div className="delivery-head">
        <div>
          <Link to={`/endpoints/${d.endpoint_id}`}>{endpointLabel({ kind: d.endpoint_kind, url: d.endpoint_url, description: d.endpoint_description })}</Link>{" "}
          <Status value={d.status} />
          {d.status === "pending" && d.attempt_count > 0 && (
            <span className="muted small">
              {" "}
              next attempt <Time iso={d.next_attempt_at} />
            </span>
          )}
        </div>
        {canWrite && finished && (
          <button type="button" className="btn" onClick={retry}>
            {d.status === "succeeded" ? "Send again" : "Retry now"}
          </button>
        )}
      </div>
      <ol className="attempts">
        {(attempts.data?.items ?? []).map((a) => {
          const ok = a.response_status !== null && a.response_status < 300;
          return (
            <li key={a.id} className={ok ? "ok" : ""}>
              <span className="no">#{a.attempt_no}</span>
              <span className={ok ? "code-ok" : "code-fail"}>{a.response_status ?? a.error_kind ?? "error"}</span>
              <span className="muted small">
                {a.duration_ms} ms, <Time iso={a.started_at} />
                {a.transport === "relay" && ", via CLI relay"}
                {a.error_detail && <span title={a.error_detail}>, {a.error_kind}</span>}
              </span>
              <span />
              {a.response_snippet && (
                <details>
                  <summary>Response body</summary>
                  <pre className="json" style={{ marginTop: 6, maxHeight: 200 }}>
                    {a.response_snippet}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
        {attempts.data?.items.length === 0 && <li className="none muted small">Not attempted yet.</li>}
      </ol>
      <Toast text={toast} />
    </div>
  );
}
