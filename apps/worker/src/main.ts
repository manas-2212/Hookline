import { startTelemetry } from "@hookline/telemetry";

const telemetry = startTelemetry("hookline-worker");

const { createServer } = await import("node:http");
const { loadConfig } = await import("@hookline/config");
const { parseAllowlist } = await import("@hookline/core");
const { createDb, migrate } = await import("@hookline/db");
const { createRateLimiter } = await import("@hookline/ratelimit");
const { pino } = await import("pino");
const { startJobs } = await import("./jobs.js");
const { registry } = await import("./metrics.js");
const { HttpTransport } = await import("./transport.js");
const { DeliveryWorker } = await import("./worker.js");

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "hookline-worker" } });
await migrate(cfg.DATABASE_URL);
const { db, pool } = createDb(cfg.DATABASE_URL, { max: Math.min(cfg.WORKER_CONCURRENCY + 4, 40) });
const limiter = createRateLimiter(cfg.REDIS_URL);
const transport = new HttpTransport({
  connectTimeoutMs: cfg.CONNECT_TIMEOUT_MS,
  requestTimeoutMs: cfg.REQUEST_TIMEOUT_MS,
  allowlist: parseAllowlist(cfg.ENDPOINT_ALLOWLIST),
});
const worker = new DeliveryWorker(
  { db, pool, transport, limiter, encKey: Buffer.from(cfg.ENCRYPTION_KEY, "base64"), log },
  {
    concurrency: cfg.WORKER_CONCURRENCY,
    batchSize: cfg.CLAIM_BATCH_SIZE,
    leaseSeconds: cfg.LEASE_SECONDS,
    maxInFlightPerEndpoint: cfg.ENDPOINT_MAX_IN_FLIGHT,
    retryDelayScale: Number(process.env.RETRY_DELAY_SCALE ?? 1),
  },
);
const stopJobs = startJobs(db, log, {
  retentionDays: cfg.RETENTION_DAYS,
  reapEveryMs: Number(process.env.REAP_EVERY_MS ?? 10_000),
});

const metricsServer = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": registry.contentType });
    res.end(await registry.metrics());
  } else if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
  } else {
    res.writeHead(404).end();
  }
}).listen(cfg.WORKER_METRICS_PORT);

await worker.start();
log.info({ worker: worker.id, concurrency: cfg.WORKER_CONCURRENCY }, "worker started");

const shutdown = async (signal: string) => {
  log.info({ signal }, "draining");
  stopJobs();
  await worker.stop();
  metricsServer.close();
  await transport.close();
  await limiter.close();
  await db.destroy();
  await telemetry?.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
