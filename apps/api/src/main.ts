import { startTelemetry } from "@hookline/telemetry";

const telemetry = startTelemetry("hookline-api");

const { loadConfig } = await import("@hookline/config");
const { createDb, migrate } = await import("@hookline/db");
const { createRateLimiter } = await import("@hookline/ratelimit");
const { EventHub } = await import("./hub.js");
const { buildServer } = await import("./server.js");

const cfg = loadConfig();
await migrate(cfg.DATABASE_URL);
const { db, pool } = createDb(cfg.DATABASE_URL);
const hub = new EventHub(pool);
const limiter = createRateLimiter(cfg.REDIS_URL);
const app = await buildServer({ cfg, db, pool, hub, limiter, encKey: Buffer.from(cfg.ENCRYPTION_KEY, "base64") });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await hub.close();
  await limiter.close();
  await db.destroy();
  await telemetry?.shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });
