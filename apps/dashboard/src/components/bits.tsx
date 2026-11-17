import { useEffect, useState } from "react";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

export function Time({ iso }: { iso: string | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className="muted">never</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

export const fmt = (n: number) => n.toLocaleString("en-US");

export function Status({ value, label }: { value: string; label?: string }) {
  const text = label ?? { in_flight: "sending", pending: "waiting", succeeded: "delivered" }[value] ?? value;
  return <span className={`status ${value}`}>{text}</span>;
}

export function Health({ ok, total }: { ok: number; total: number }) {
  if (total === 0) return <span className="muted small">no traffic in 24 h</span>;
  const pct = Math.round((ok / total) * 100);
  const cls = pct >= 99 ? "" : pct >= 90 ? "warn" : "bad";
  return (
    <span>
      <span className={`health ${cls}`} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}

/** Pretty JSON with light syntax colouring; safe because it renders text nodes only. */
export function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "";
  const parts: Array<{ t: string; c?: string }> = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|\b(true|false|null)\b/gi;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index) });
    if (m[1]) {
      parts.push({ t: m[1], c: m[2] ? "k" : "s" });
      if (m[2]) parts.push({ t: m[2] });
    } else parts.push({ t: m[0], c: "n" });
    last = m.index + m[0].length;
  }
  parts.push({ t: text.slice(last) });
  return (
    <pre className="json">
      {parts.map((p, i) =>
        p.c ? (
          <span key={i} className={p.c}>
            {p.t}
          </span>
        ) : (
          p.t
        ),
      )}
    </pre>
  );
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

export function useToast(): [string | null, (t: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), 3000);
    return () => clearTimeout(t);
  }, [text]);
  return [text, setText];
}

/** Attempts per minute for the last hour: delivered above the baseline, failures hang below it. */
export function MinuteBars({ data }: { data: Array<{ minute: string; succeeded: number; failed: number }> }) {
  const W = 600;
  const H = 72;
  const mid = 48;
  const max = Math.max(1, ...data.map((d) => d.succeeded));
  const maxF = Math.max(1, ...data.map((d) => d.failed));
  const bw = W / Math.max(1, data.length);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="bars" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Attempts per minute over the last hour">
        <line x1="0" x2={W} y1={mid} y2={mid} stroke="var(--rule)" />
        {data.map((d, i) => {
          const h = (d.succeeded / max) * (mid - 2);
          const hf = (d.failed / maxF) * (H - mid - 2);
          return (
            <g key={d.minute}>
              <title>{`${new Date(d.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${d.succeeded} delivered, ${d.failed} failed`}</title>
              {d.succeeded > 0 && <rect x={i * bw + 1} y={mid - h} width={Math.max(1, bw - 2)} height={h} fill="var(--ok)" opacity="0.8" />}
              {d.failed > 0 && <rect x={i * bw + 1} y={mid + 1} width={Math.max(1, bw - 2)} height={hf} fill="var(--fail)" opacity="0.8" />}
            </g>
          );
        })}
      </svg>
      <figcaption className="bars-cap">
        <span>an hour ago</span>
        <span>attempts per minute, failures below the line</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
