import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activeSecrets,
  claimDue,
  completeAttempt,
  createApp,
  createEndpoint,
  createTestDatabase,
  type Db,
  disableLongFailing,
  ingestMessage,
  reapExpired,
  replay,
  retryDelivery,
  rotateSecret,
} from "../src/index.js";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
const key = randomBytes(32);
const claim = (workerId: string, o: Partial<Parameters<typeof claimDue>[1]> = {}) =>
  claimDue(db, { workerId, batchSize: 100, leaseSeconds: 60, maxInFlightPerEndpoint: 8, ...o });
const record = {
  transport: "http" as const,
  startedAt: new Date(),
  durationMs: 5,
  responseStatus: 200,
  responseSnippet: "ok",
  errorKind: null,
  errorDetail: null,
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});
afterAll(() => t.drop());
beforeEach(async () => {
  await sql`TRUNCATE apps CASCADE`.execute(db);
});

async function setup(endpoints: Array<{ types?: string[] | null; status?: "paused" }> = [{}]) {
  const app = await createApp(db, "a");
  const eps = [];
  for (const e of endpoints) {
    const { endpoint } = await createEndpoint(db, key, {
      appId: app.id,
      kind: "http",
      url: `https://${randomBytes(3).toString("hex")}.example`,
      description: null,
      eventTypes: e.types ?? null,
      rateLimitPerSec: null,
    });
    if (e.status) await db.updateTable("endpoints").set({ status: e.status }).where("id", "=", endpoint.id).execute();
    eps.push(endpoint);
  }
  return { app, eps };
}

describe("ingest and fan-out", () => {
  it("creates one delivery per active matching endpoint, none for paused or filtered ones", async () => {
    const { app } = await setup([{}, { types: ["a.b"] }, { types: ["x.y"] }, { status: "paused" }]);
    const r = await ingestMessage(db, { appId: app.id, eventType: "a.b", payload: { n: 1 }, idempotencyKey: null });
    expect(r.kind === "created" && r.deliveries).toBe(2);
  });

  it("is atomic: a failure after the message insert leaves nothing behind", async () => {
    const { app } = await setup();
    await expect(
      ingestMessage(
        db,
        { appId: app.id, eventType: "a", payload: {}, idempotencyKey: "k1" },
        {
          afterInsert: () => {
            throw new Error("boom");
          },
        },
      ),
    ).rejects.toThrow("boom");
    const [m, d] = await Promise.all([
      db.selectFrom("messages").select(sql<number>`count(*)`.as("n")).executeTakeFirstOrThrow(),
      db.selectFrom("deliveries").select(sql<number>`count(*)`.as("n")).executeTakeFirstOrThrow(),
    ]);
    expect([m.n, d.n]).toEqual([0, 0]);
  });

  it("deduplicates by idempotency key, including concurrent duplicates", async () => {
    const { app } = await setup();
    const send = (payload: unknown) => ingestMessage(db, { appId: app.id, eventType: "a", payload, idempotencyKey: "same" });
    const results = await Promise.all(Array.from({ length: 10 }, () => send({ x: 1 })));
    const ids = new Set(results.map((r) => (r.kind === "conflict" ? "conflict" : r.message.id)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect((await send({ x: 2 })).kind).toBe("conflict");
    expect((await send({ x: 1 })).kind).toBe("duplicate");
  });

  it("stores the payload text exactly as sent (key order preserved)", async () => {
    const { app } = await setup();
    const r = await ingestMessage(db, { appId: app.id, eventType: "a", payload: { z: 1, a: 2 }, idempotencyKey: null });
    const row = await sql<{ t: string }>`SELECT payload::text AS t FROM messages WHERE id = ${r.kind === "created" ? r.message.id : ""}`.execute(db);
    expect(row.rows[0]?.t).toBe('{"z":1,"a":2}');
  });
});

describe("claiming", () => {
  it("never hands the same delivery to two concurrent workers", async () => {
    const { app } = await setup([{}, {}, {}, {}]);
    for (let i = 0; i < 50; i++) await ingestMessage(db, { appId: app.id, eventType: "a", payload: { i }, idempotencyKey: null });
    const batches = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w${i}`, { batchSize: 40, maxInFlightPerEndpoint: 1000 })));
    const ids = batches.flat().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(200);
  });

  it("is fair: a flooded endpoint gets at most its cap, others are not starved", async () => {
    const { app, eps } = await setup([{ types: ["flood"] }, { types: ["calm"] }]);
    for (let i = 0; i < 300; i++) await ingestMessage(db, { appId: app.id, eventType: "flood", payload: { i }, idempotencyKey: null });
    for (let i = 0; i < 3; i++) await ingestMessage(db, { appId: app.id, eventType: "calm", payload: { i }, idempotencyKey: null });
    const got = await claim("w1", { batchSize: 64, maxInFlightPerEndpoint: 8 });
    const flood = got.filter((d) => d.endpoint_id === eps[0]?.id).length;
    const calm = got.filter((d) => d.endpoint_id === eps[1]?.id).length;
    expect(flood).toBe(8);
    expect(calm).toBe(3);
    expect(await claim("w2")).toHaveLength(0); // flood endpoint is at its cap
  });

  it("gives a degraded endpoint (5+ consecutive failures) only one slot", async () => {
    const { app, eps } = await setup();
    await db.updateTable("endpoints").set({ consecutive_failures: 5 }).execute();
    for (let i = 0; i < 5; i++) await ingestMessage(db, { appId: app.id, eventType: "a", payload: { i }, idempotencyKey: null });
    const got = await claim("w1");
    expect(got).toHaveLength(1);
    expect(got[0]?.endpoint_id).toBe(eps[0]?.id);
  });

  it("does not claim deliveries that are not yet due", async () => {
    const { app } = await setup();
    await ingestMessage(db, { appId: app.id, eventType: "a", payload: {}, idempotencyKey: null });
    await db.updateTable("deliveries").set({ next_attempt_at: sql`now() + interval '1 minute'` }).execute();
    expect(await claim("w1")).toHaveLength(0);
  });
});

describe("leases, completion and the reaper", () => {
  it("returns expired leases to the queue", async () => {
    const { app } = await setup();
    await ingestMessage(db, { appId: app.id, eventType: "a", payload: {}, idempotencyKey: null });
    const [d] = await claim("crashed-worker", { leaseSeconds: 60 });
    expect(await reapExpired(db)).toBe(0); // lease still valid
    await db.updateTable("deliveries").set({ locked_until: sql`now() - interval '1 second'` }).execute();
    expect(await reapExpired(db)).toBe(1);
    const [again] = await claim("w2");
    expect(again?.id).toBe(d?.id);
  });

  it("ignores a completion from a worker that lost its lease", async () => {
    const { app } = await setup();
    await ingestMessage(db, { appId: app.id, eventType: "a", payload: {}, idempotencyKey: null });
    const [d] = await claim("slow-worker");
    if (!d) throw new Error("expected a claim");
    await db.updateTable("deliveries").set({ locked_until: sql`now() - interval '1 second'` }).execute();
    await reapExpired(db);
    await claim("w2");
    const r = await completeAttempt(db, { deliveryId: d.id, workerId: "slow-worker", decision: { kind: "succeeded" }, record });
    expect(r).toEqual({ applied: false, reason: "lost_lease" });
    const ok = await completeAttempt(db, { deliveryId: d.id, workerId: "w2", decision: { kind: "succeeded" }, record });
    expect(ok).toMatchObject({ applied: true, attemptNo: 1, status: "succeeded" });
  });

  it("records attempts with increasing numbers and schedules retries", async () => {
    const { app, eps } = await setup();
    await ingestMessage(db, { appId: app.id, eventType: "a", payload: {}, idempotencyKey: null });
    const [d] = await claim("w1");
    if (!d) throw new Error("expected a claim");
    await completeAttempt(db, { deliveryId: d.id, workerId: "w1", decision: { kind: "retry", delayMs: 0 }, record: { ...record, responseStatus: 500 } });
    const [d2] = await claim("w1");
    expect(d2?.id).toBe(d.id);
    await completeAttempt(db, { deliveryId: d.id, workerId: "w1", decision: { kind: "succeeded" }, record });
    const attempts = await db.selectFrom("attempts").select(["attempt_no", "response_status"]).orderBy("attempt_no").execute();
    expect(attempts).toEqual([
      { attempt_no: 1, response_status: 500 },
      { attempt_no: 2, response_status: 200 },
    ]);
    const ep = await db
      .selectFrom("endpoints")
      .select(["consecutive_failures", "last_success_at"])
      .where("id", "=", eps[0]?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(ep.consecutive_failures).toBe(0);
    expect(ep.last_success_at).not.toBeNull();
  });

  it("on 410 Gone disables the endpoint and cancels its other pending deliveries", async () => {
    const { app } = await setup();
    for (let i = 0; i < 3; i++) await ingestMessage(db, { appId: app.id, eventType: "a", payload: { i }, idempotencyKey: null });
    const [d] = await claim("w1", { batchSize: 1 });
    if (!d) throw new Error("expected a claim");
    await completeAttempt(db, { deliveryId: d.id, workerId: "w1", decision: { kind: "endpoint_gone" }, record: { ...record, responseStatus: 410 } });
    const ep = await db.selectFrom("endpoints").select(["status", "disabled_reason"]).executeTakeFirstOrThrow();
    expect(ep).toEqual({ status: "disabled", disabled_reason: "gone" });
    const statuses = (await db.selectFrom("deliveries").select("status").execute()).map((r) => r.status).sort();
    expect(statuses).toEqual(["cancelled", "cancelled", "failed"]);
  });
});

describe("retry, replay, rotation, breaker", () => {
  it("manual retry starts a new cycle on a failed delivery", async () => {
    const { app } = await setup();
    await ingestMessage(db, { appId: app.id, eventType: "a", payload: {}, idempotencyKey: null });
    const [d] = await claim("w1");
    if (!d) throw new Error("expected a claim");
    await completeAttempt(db, {
      deliveryId: d.id,
      workerId: "w1",
      decision: { kind: "failed", reason: "exhausted" },
      record: { ...record, responseStatus: 500 },
    });
    const retried = await retryDelivery(db, app.id, d.id);
    expect(retried).toMatchObject({ status: "pending", retry_base: 1, attempt_count: 1 });
    expect(await retryDelivery(db, app.id, d.id)).toBeUndefined(); // already pending
  });

  it("replay back-fills messages sent before an endpoint existed", async () => {
    const app = await createApp(db, "a");
    const since = new Date(Date.now() - 1000);
    for (let i = 0; i < 4; i++) await ingestMessage(db, { appId: app.id, eventType: "a", payload: { i }, idempotencyKey: null });
    const { endpoint } = await createEndpoint(db, key, {
      appId: app.id,
      kind: "http",
      url: "https://late.example",
      description: null,
      eventTypes: null,
      rateLimitPerSec: null,
    });
    expect(await replay(db, { appId: app.id, endpointId: endpoint.id, since, until: new Date(Date.now() + 1000), onlyFailed: false })).toBe(4);
    // replaying again does not touch deliveries that are still pending
    expect(await replay(db, { appId: app.id, endpointId: endpoint.id, since, until: new Date(Date.now() + 1000), onlyFailed: false })).toBe(0);
  });

  it("rotation keeps the old secret valid alongside the new one", async () => {
    const app = await createApp(db, "a");
    const { endpoint, secret } = await createEndpoint(db, key, {
      appId: app.id,
      kind: "http",
      url: "https://r.example",
      description: null,
      eventTypes: null,
      rateLimitPerSec: null,
    });
    const next = await rotateSecret(db, key, app.id, endpoint.id);
    expect(await activeSecrets(db, key, endpoint.id)).toEqual([next, secret]);
    await db.updateTable("endpoint_secrets").set({ expires_at: sql`now() - interval '1 second'` }).where("expires_at", "is not", null).execute();
    expect(await activeSecrets(db, key, endpoint.id)).toEqual([next]);
    const raw = await db.selectFrom("endpoint_secrets").select("secret_enc").execute();
    for (const r of raw) expect(r.secret_enc.toString("latin1")).not.toContain("whsec_");
  });

  it("disables endpoints that have failed continuously past the threshold", async () => {
    const { eps } = await setup([{}, {}]);
    await db
      .updateTable("endpoints")
      .set({ consecutive_failures: 12, last_success_at: sql`now() - interval '6 days'` })
      .where("id", "=", eps[0]?.id ?? "")
      .execute();
    const off = await disableLongFailing(db, 5 * 86_400_000);
    expect(off.map((e) => e.id)).toEqual([eps[0]?.id]);
  });
});
