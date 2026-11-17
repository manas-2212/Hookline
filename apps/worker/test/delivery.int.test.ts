import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parseAllowlist } from "@hookline/core";
import { createApp, createEndpoint, createTestDatabase, ingestMessage } from "@hookline/db";
import { MemoryRateLimiter } from "@hookline/ratelimit";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildReceiver, type ReceiverStats } from "../../chaos-receiver/src/receiver.js";
import { HttpTransport } from "../src/transport.js";
import { DeliveryWorker } from "../src/worker.js";

/**
 * End-to-end: real Postgres, real HTTP to the in-process chaos receiver, real signatures.
 * Retry delays are scaled down 1000× so the whole 10-attempt schedule runs in seconds.
 */
let t: Awaited<ReturnType<typeof createTestDatabase>>;
let rx: ReturnType<typeof buildReceiver>;
let base: string;
const encKey = randomBytes(32);
const log = pino({ level: "silent" });

beforeAll(async () => {
  t = await createTestDatabase();
  rx = buildReceiver();
  await rx.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(rx.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await rx.close();
  await t.drop();
});

// One limiter shared by every worker, as Redis would be in production. (Separate in-memory
// limiters per worker would each allow the full rate.)
const limiter = new MemoryRateLimiter();
const running: Array<{ w: DeliveryWorker; t: HttpTransport }> = [];
const newWorker = (id: string, o: Partial<ConstructorParameters<typeof DeliveryWorker>[1]> = {}) => {
  const tr = new HttpTransport({ connectTimeoutMs: 1000, requestTimeoutMs: 1500, allowlist: parseAllowlist("127.0.0.1/32") });
  const w = new DeliveryWorker(
    { db: t.db, pool: t.pool, transport: tr, limiter, encKey, log, workerId: id, rng: () => 0.5 },
    { concurrency: 16, batchSize: 32, leaseSeconds: 10, maxInFlightPerEndpoint: 8, retryDelayScale: 0.001, idleMaxMs: 50, ...o },
  );
  running.push({ w, t: tr });
  return w;
};
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.w.stop();
    await r.t.close();
  }
});
const stats = async (): Promise<ReceiverStats> => (await rx.inject({ method: "GET", url: "/_control/stats" })).json();
const until = async (cond: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
};

async function endpoint(appId: string, query: string, eventTypes: string[] | null = null, rate: number | null = null) {
  const { endpoint, secret } = await createEndpoint(t.db, encKey, {
    appId,
    kind: "http",
    url: `${base}/hook?${query}`,
    description: null,
    eventTypes,
    rateLimitPerSec: rate,
  });
  await rx.inject({ method: "POST", url: "/_control/secrets", payload: { secret } });
  return endpoint;
}

describe("delivery worker", () => {
  it("delivers 100 messages with valid signatures using two workers, no duplicates", async () => {
    await rx.inject({ method: "POST", url: "/_control/reset" });
    const app = await createApp(t.db, "happy");
    await endpoint(app.id, "name=happy", ["happy"]);
    const [w1, w2] = [newWorker("w1"), newWorker("w2")];
    await Promise.all([w1.start(), w2.start()]);
    for (let i = 0; i < 100; i++) await ingestMessage(t.db, { appId: app.id, eventType: "happy", payload: { i }, idempotencyKey: null });
    await until(async () => (await stats()).unique_accepted === 100);
    await Promise.all([w1.stop(), w2.stop()]);
    const s = await stats();
    expect(s).toMatchObject({ unique_accepted: 100, duplicates: 0, bad_signatures: 0 });
  });

  it("retries a failing endpoint and succeeds on attempt k+1", async () => {
    await rx.inject({ method: "POST", url: "/_control/reset" });
    const app = await createApp(t.db, "flaky");
    const ep = await endpoint(app.id, "name=ff&fail_first=3", ["ff"]);
    const w = newWorker("w-ff");
    await w.start();
    await ingestMessage(t.db, { appId: app.id, eventType: "ff", payload: {}, idempotencyKey: null });
    await until(async () => (await stats()).unique_accepted === 1);
    await w.stop();
    const attempts = await t.db
      .selectFrom("attempts")
      .select(["attempt_no", "response_status"])
      .where("endpoint_id", "=", ep.id)
      .orderBy("attempt_no")
      .execute();
    expect(attempts.map((a) => a.response_status)).toEqual([500, 500, 500, 200]);
  });

  it("gives up after 10 attempts and marks the delivery failed", async () => {
    const app = await createApp(t.db, "dead");
    const ep = await endpoint(app.id, "name=dead&status=500", ["dead"]);
    // The real schedule spans ~23 h; at 1/10,000 it takes ~8 s.
    const w = newWorker("w-dead", { retryDelayScale: 0.0001 });
    await w.start();
    await ingestMessage(t.db, { appId: app.id, eventType: "dead", payload: {}, idempotencyKey: null });
    await until(async () => {
      const d = await t.db.selectFrom("deliveries").select("status").where("endpoint_id", "=", ep.id).executeTakeFirst();
      return d?.status === "failed";
    }, 60_000);
    await w.stop();
    const n = await t.db
      .selectFrom("attempts")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("endpoint_id", "=", ep.id)
      .executeTakeFirstOrThrow();
    expect(n.n).toBe(10);
  });

  it("disables an endpoint that answers 410 Gone", async () => {
    const app = await createApp(t.db, "gone");
    const ep = await endpoint(app.id, "name=gone&status=410", ["gone"]);
    const w = newWorker("w-gone");
    await w.start();
    await ingestMessage(t.db, { appId: app.id, eventType: "gone", payload: {}, idempotencyKey: null });
    await until(async () => (await t.db.selectFrom("endpoints").select("status").where("id", "=", ep.id).executeTakeFirst())?.status === "disabled");
    await w.stop();
  });

  it("respects an endpoint's rate limit without spending attempts", async () => {
    await rx.inject({ method: "POST", url: "/_control/reset" });
    const app = await createApp(t.db, "rate");
    const ep = await endpoint(app.id, "name=rate", ["rate"], 5);
    const w = newWorker("w-rate");
    await w.start();
    const started = Date.now();
    for (let i = 0; i < 15; i++) await ingestMessage(t.db, { appId: app.id, eventType: "rate", payload: { i }, idempotencyKey: null });
    await until(async () => (await stats()).unique_accepted === 15);
    const elapsed = Date.now() - started;
    await w.stop();
    // burst of 5, then 5/s: the last 10 need at least ~2 s.
    expect(elapsed).toBeGreaterThan(1500);
    const attempts = await t.db.selectFrom("attempts").select("attempt_no").where("endpoint_id", "=", ep.id).execute();
    expect(attempts.every((a) => a.attempt_no === 1)).toBe(true);
  });

  it("keeps a healthy endpoint fast while a slow one is flooded (fairness)", async () => {
    await rx.inject({ method: "POST", url: "/_control/reset" });
    const app = await createApp(t.db, "fair");
    await endpoint(app.id, "name=slow&latency=400", ["slow"]);
    const healthy = await endpoint(app.id, "name=healthy", ["healthy"]);
    const w = newWorker("w-fair", { concurrency: 16, maxInFlightPerEndpoint: 4 });
    await w.start();
    for (let i = 0; i < 200; i++) await ingestMessage(t.db, { appId: app.id, eventType: "slow", payload: { i }, idempotencyKey: null });
    for (let i = 0; i < 20; i++) await ingestMessage(t.db, { appId: app.id, eventType: "healthy", payload: { i }, idempotencyKey: null });
    await until(async () => ((await stats()).by_name.healthy?.accepted ?? 0) === 20, 10_000);
    const lat = await t.db
      .selectFrom("deliveries")
      .select((eb) => eb.fn.max<Date>("first_attempt_at").as("last"))
      .where("endpoint_id", "=", healthy.id)
      .executeTakeFirstOrThrow();
    const slowDone = (await stats()).by_name.slow?.accepted ?? 0;
    await w.stop();
    // All 20 healthy deliveries finished while most of the slow backlog was still waiting.
    expect(slowDone).toBeLessThan(200);
    expect(lat.last).not.toBeNull();
  });
});
