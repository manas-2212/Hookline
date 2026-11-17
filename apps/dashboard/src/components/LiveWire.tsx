import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type Endpoint, endpointLabel, type WireEvent } from "../api";

const WINDOW_MS = 120_000;

/** Track the element's pixel width so marks are drawn in real pixels (no stretched dots). */
function useWidth<T extends Element>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(100, entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Track({ events, now, active, label }: { events: WireEvent[]; now: number; active: boolean; label: string }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const PAD = 6; // keep the newest marks fully visible at the right edge
  const x = (at: number) => W - PAD - ((now - at) / WINDOW_MS) * (W - 2 * PAD);
  return (
    <div ref={ref}>
      <svg width={W} height="34" role="img" aria-label={label}>
        <line x1="0" y1="17" x2={W} y2="17" stroke="var(--wire)" strokeWidth="1" strokeDasharray={active ? undefined : "3 4"} />
        {events.map((e) => {
          const cx = x(e.at);
          if (e.outcome === "failed" || e.outcome === "cancelled") {
            return <rect key={e.key} x={cx - 1.5} y="5" width="3" height="24" fill="var(--fail)" />;
          }
          if (e.outcome === "pending") {
            return <circle key={e.key} cx={cx} cy="17" r="5" fill="var(--surface)" stroke="var(--retry)" strokeWidth="1.6" />;
          }
          return <circle key={e.key} cx={cx} cy="17" r="4.5" fill="var(--ok)" opacity={Math.max(0.35, 1 - (now - e.at) / WINDOW_MS)} />;
        })}
      </svg>
    </div>
  );
}

/**
 * One lane per endpoint, time running right to left over the last two minutes. Every attempt is
 * a mark on its endpoint's wire: a filled dot when it was delivered, an open ring when a retry
 * was scheduled, a red bar when the delivery gave up. Fed by the SSE stream.
 */
export function LiveWire({ endpoints, events, connected }: { endpoints: Endpoint[]; events: WireEvent[]; connected: boolean }) {
  const reduced = useMemo(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), reduced ? 2000 : 250);
    return () => clearInterval(t);
  }, [reduced]);

  const byEndpoint = useMemo(() => {
    const m = new Map<string, WireEvent[]>();
    for (const e of events) {
      if (now - e.at > WINDOW_MS) continue;
      const list = m.get(e.endpoint_id) ?? [];
      list.push(e);
      m.set(e.endpoint_id, list);
    }
    return m;
  }, [events, now]);

  const lanes = endpoints.filter((e) => e.status !== "disabled" || byEndpoint.has(e.id));

  return (
    <section className="wire" aria-label="Live delivery attempts for the last two minutes">
      <div className="wire-head">
        <h2>Live wire</h2>
        <div className="wire-legend" aria-hidden="true">
          <span>
            <svg width="10" height="10" aria-hidden="true">
              <circle cx="5" cy="5" r="4" fill="var(--ok)" />
            </svg>
            delivered
          </span>
          <span>
            <svg width="10" height="10" aria-hidden="true">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--retry)" strokeWidth="1.5" />
            </svg>
            retry scheduled
          </span>
          <span>
            <svg width="10" height="10" aria-hidden="true">
              <rect x="3.5" y="0" width="3" height="10" fill="var(--fail)" />
            </svg>
            gave up
          </span>
          <span>{connected ? "streaming" : "reconnecting…"}</span>
        </div>
      </div>
      {lanes.length === 0 && <p className="wire-empty">Add an endpoint and its deliveries will appear here as they happen.</p>}
      {lanes.map((ep) => {
        const evs = byEndpoint.get(ep.id) ?? [];
        const perMin = evs.filter((e) => now - e.at < 60_000).length;
        return (
          <div className="wire-lane" key={ep.id}>
            <Link className="name" to={`/endpoints/${ep.id}`} title={ep.url ?? "CLI relay"}>
              {endpointLabel(ep)}
            </Link>
            <Track events={evs} now={now} active={ep.status === "active"} label={`${evs.length} attempts in the last two minutes`} />
            <span className="rate">{perMin}/min</span>
          </div>
        );
      })}
      {lanes.length > 0 && (
        <div className="wire-axis" aria-hidden="true">
          <span />
          <div>
            <span>2 min ago</span>
            <span>1 min</span>
            <span>now</span>
          </div>
          <span />
        </div>
      )}
    </section>
  );
}
