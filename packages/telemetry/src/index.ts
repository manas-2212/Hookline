import { context, type Link, type SpanContext, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Starts OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise does nothing.
 * Must run before http/pg are imported, which is why main.ts imports everything else lazily.
 */
export function startTelemetry(serviceName: string): NodeSDK | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  return sdk;
}

/** A span link to the trace that ingested a message (stored as W3C traceparent). */
export function linkFromTraceparent(tp: string | null): Link[] {
  const m = tp ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(tp) : null;
  if (!m?.[1] || !m[2]) return [];
  const sc: SpanContext = { traceId: m[1], spanId: m[2], traceFlags: TraceFlags.SAMPLED, isRemote: true };
  return [{ context: sc }];
}

/** traceparent header for an outgoing request, continuing the current span (if any). */
export function currentTraceparent(): string | null {
  const sc = trace.getSpan(context.active())?.spanContext();
  if (!sc || !trace.isSpanContextValid(sc)) return null;
  return `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags & 1}`;
}

export const tracer = trace.getTracer("hookline");
