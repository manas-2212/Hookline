import { randomBytes } from "node:crypto";

/** W3C traceparent helpers: lets a trace started at ingest continue in the worker. */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(v: string | null | undefined): { traceId: string; spanId: string; flags: string } | null {
  if (!v) return null;
  const m = TRACEPARENT_RE.exec(v.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2], flags: m[3] };
}

export function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
