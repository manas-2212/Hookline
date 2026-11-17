import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "hookline_worker_" });

export const attemptsTotal = new client.Counter({
  name: "hookline_attempts_total",
  help: "Delivery attempts by outcome",
  labelNames: ["outcome", "error_kind"],
  registers: [registry],
});

export const attemptDuration = new client.Histogram({
  name: "hookline_attempt_duration_seconds",
  help: "Duration of one HTTP delivery attempt",
  labelNames: ["outcome"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [registry],
});

export const deliveryLatency = new client.Histogram({
  name: "hookline_delivery_latency_seconds",
  help: "Time from ingest to the first attempt starting",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const lostLeases = new client.Counter({
  name: "hookline_lost_leases_total",
  help: "Attempts whose lease expired before they were recorded",
  registers: [registry],
});

export const reapedTotal = new client.Counter({
  name: "hookline_reaped_total",
  help: "Deliveries returned to the queue after their lease expired",
  registers: [registry],
});

export const queueDepthGauge = new client.Gauge({
  name: "hookline_queue_depth",
  help: "Deliveries waiting or in flight",
  labelNames: ["status"],
  registers: [registry],
});
