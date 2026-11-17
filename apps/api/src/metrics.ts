import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "hookline_api_" });

export const httpDuration = new client.Histogram({
  name: "hookline_http_request_duration_seconds",
  help: "API request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const messagesIngested = new client.Counter({
  name: "hookline_messages_ingested_total",
  help: "Messages accepted by the ingest API",
  registers: [registry],
});

export const liveClients = new client.Gauge({
  name: "hookline_live_clients",
  help: "Connected SSE and relay clients",
  labelNames: ["kind"],
  registers: [registry],
});
