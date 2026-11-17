import { randomBytes } from "node:crypto";
import { loadConfig } from "@hookline/config";
import { addMembership, createApiKey, createApp, createTestDatabase, upsertUser } from "@hookline/db";
import { MemoryRateLimiter } from "@hookline/ratelimit";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps.js";
import { EventHub } from "../src/hub.js";
import { buildServer } from "../src/server.js";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let app: FastifyInstance;
let deps: Deps;
let keyA: string;
let keyB: string;
let appA: string;

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

beforeAll(async () => {
  t = await createTestDatabase();
  const cfg = loadConfig({ DATABASE_URL: t.url, DEV_LOGIN: "true", INGEST_RATE_PER_SEC: "5", LOG_LEVEL: "silent" });
  deps = { cfg, db: t.db, pool: t.pool, limiter: new MemoryRateLimiter(), hub: new EventHub(t.pool), encKey: randomBytes(32) };
  app = await buildServer(deps, { logger: false });
  const a = await createApp(t.db, "A");
  const b = await createApp(t.db, "B");
  appA = a.id;
  keyA = (await createApiKey(t.db, a.id)).key;
  keyB = (await createApiKey(t.db, b.id)).key;
});
afterAll(async () => {
  await app.close();
  await deps.hub.close();
  await t.drop();
});

describe("authentication", () => {
  it("rejects missing, malformed and revoked keys", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/endpoints" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/endpoints", headers: bearer("hk_nope") })).statusCode).toBe(401);
    const k = await createApiKey(t.db, appA);
    expect((await app.inject({ method: "GET", url: "/v1/endpoints", headers: bearer(k.key) })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/v1/api-keys/${k.id}`, headers: bearer(keyA) });
    expect((await app.inject({ method: "GET", url: "/v1/endpoints", headers: bearer(k.key) })).statusCode).toBe(401);
  });

  it("stores API keys only as hashes", async () => {
    const rows = await t.db.selectFrom("api_keys").select(["key_hash", "prefix"]).execute();
    for (const r of rows) expect(r.key_hash.toString("utf8")).not.toContain("hk_");
  });

  it("answers errors as RFC 9457 problem+json", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/endpoints" });
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect(r.json()).toMatchObject({ status: 401, title: "Unauthorized" });
  });
});

describe("endpoints", () => {
  it("returns the secret once, on create, and never stores it in plaintext", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/endpoints", headers: bearer(keyA), payload: { url: "https://example.com/hook" } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.secret).toMatch(/^whsec_/);
    const get = await app.inject({ method: "GET", url: `/v1/endpoints/${body.id}`, headers: bearer(keyA) });
    expect(get.json().secret).toBeUndefined();
    const raw = await t.db.selectFrom("endpoint_secrets").select("secret_enc").execute();
    for (const s of raw) expect(s.secret_enc.toString("latin1")).not.toContain(body.secret.slice(6, 20));
  });

  it("isolates tenants: another app's endpoint is a 404 for read, update and delete", async () => {
    const created = (await app.inject({ method: "POST", url: "/v1/endpoints", headers: bearer(keyA), payload: { url: "https://a.example" } })).json();
    for (const [method, payload] of [["GET"], ["PATCH", { status: "paused" }], ["DELETE"]] as const) {
      const r = await app.inject({ method, url: `/v1/endpoints/${created.id}`, headers: bearer(keyB), payload });
      expect(r.statusCode).toBe(404);
    }
    const list = (await app.inject({ method: "GET", url: "/v1/endpoints", headers: bearer(keyB) })).json();
    expect(list.items.find((e: { id: string }) => e.id === created.id)).toBeUndefined();
  });

  it.each([
    ["http://example.com", "scheme"],
    ["https://127.0.0.1/hook", "blocked_ip"],
    ["https://[::ffff:169.254.169.254]/", "blocked_ip"],
    ["https://user:pw@example.com", "credentials"],
  ])("rejects unsafe URL %s", async (url, problem) => {
    const r = await app.inject({ method: "POST", url: "/v1/endpoints", headers: bearer(keyA), payload: { url } });
    expect(r.statusCode).toBe(422);
    expect(r.json().problem).toBe(problem);
  });

  it("validates input with 400 and field paths", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/endpoints",
      headers: bearer(keyA),
      payload: { url: "https://x.example", event_types: ["bad type!"] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors.length).toBeGreaterThan(0);
  });
});

describe("messages", () => {
  it("accepts a message, fans out, and supports idempotent retries", async () => {
    const headers = { ...bearer(keyA), "idempotency-key": "order-1" };
    const first = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { event_type: "order.created", payload: { id: 1 } } });
    expect(first.statusCode).toBe(202);
    expect(first.json().deliveries).toBeGreaterThan(0);
    const again = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { event_type: "order.created", payload: { id: 1 } } });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().id).toBe(first.json().id);
    const conflict = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: { event_type: "order.created", payload: { id: 2 } } });
    expect(conflict.statusCode).toBe(409);
  });

  it("rejects payloads over 256 KB", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: bearer(keyB),
      payload: { event_type: "big", payload: { s: "x".repeat(300_000) } },
    });
    expect(r.statusCode).toBe(413);
  });

  it("rate-limits ingest per app with Retry-After", async () => {
    const fresh = await createApp(t.db, "limited");
    const k = (await createApiKey(t.db, fresh.id)).key;
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      codes.push((await app.inject({ method: "POST", url: "/v1/messages", headers: bearer(k), payload: { event_type: "x", payload: {} } })).statusCode);
    }
    expect(codes.filter((c) => c === 202).length).toBe(10); // burst = 2 × 5/s
    const limited = await app.inject({ method: "POST", url: "/v1/messages", headers: bearer(k), payload: { event_type: "x", payload: {} } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("lists with cursor pagination, newest first", async () => {
    const fresh = await createApp(t.db, "paging");
    const k = (await createApiKey(t.db, fresh.id)).key;
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/v1/messages", headers: bearer(k), payload: { event_type: "p", payload: { i } } });
    const p1 = (await app.inject({ method: "GET", url: "/v1/messages?limit=3", headers: bearer(k) })).json();
    const p2 = (await app.inject({ method: "GET", url: `/v1/messages?limit=3&cursor=${p1.next}`, headers: bearer(k) })).json();
    expect(p1.items).toHaveLength(3);
    expect(p2.items).toHaveLength(2);
    expect(p2.next).toBeNull();
    const all = [...p1.items, ...p2.items].map((m: { id: string }) => m.id);
    expect([...all].sort().reverse()).toEqual(all);
  });
});

describe("dashboard sessions and roles", () => {
  const login = async (who: string) => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { login: who } });
    const c = r.cookies.find((x) => x.name === "hl_session");
    if (!c) throw new Error("no session cookie");
    return `hl_session=${c.value}`;
  };

  it("lets owners write and viewers only read", async () => {
    const owner = await upsertUser(t.db, { githubId: null, login: "owner1", avatarUrl: null });
    const viewer = await upsertUser(t.db, { githubId: null, login: "viewer1", avatarUrl: null });
    await addMembership(t.db, owner.id, appA, "owner");
    await addMembership(t.db, viewer.id, appA, "viewer");
    const vc = await login("viewer1");
    const oc = await login("owner1");
    const hdr = (cookie: string) => ({ cookie, "x-hookline-app": appA });
    expect((await app.inject({ method: "GET", url: "/v1/endpoints", headers: hdr(vc) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/endpoints", headers: hdr(vc), payload: { url: "https://v.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/endpoints", headers: hdr(oc), payload: { url: "https://o.example" } })).statusCode).toBe(201);
  });

  it("hides apps the user is not a member of", async () => {
    const stranger = await login("stranger");
    const r = await app.inject({ method: "GET", url: "/v1/endpoints", headers: { cookie: stranger, "x-hookline-app": appA } });
    expect(r.statusCode).toBe(404);
  });

  it("requires the app header on cookie requests (CSRF guard)", async () => {
    const c = await login("owner1");
    expect((await app.inject({ method: "GET", url: "/v1/endpoints", headers: { cookie: c } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/apps", headers: { cookie: c }, payload: { name: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/apps", headers: { cookie: c, "x-hookline-csrf": "1" }, payload: { name: "x" } })).statusCode).toBe(
      201,
    );
  });

  it("rejects a forged session cookie", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: "hl_session=someone.9999999999999.forged" } });
    expect(r.statusCode).toBe(401);
  });
});

describe("misc", () => {
  it("serves an OpenAPI 3.1 document", async () => {
    const doc = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/v1/messages");
  });
  it("reports readiness from the database", async () => {
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
  it("sends a test event only to the chosen endpoint", async () => {
    const fresh = await createApp(t.db, "test-event");
    const k = (await createApiKey(t.db, fresh.id)).key;
    const e1 = (await app.inject({ method: "POST", url: "/v1/endpoints", headers: bearer(k), payload: { url: "https://one.example" } })).json();
    await app.inject({ method: "POST", url: "/v1/endpoints", headers: bearer(k), payload: { url: "https://two.example" } });
    const r = await app.inject({ method: "POST", url: `/v1/endpoints/${e1.id}/test`, headers: bearer(k) });
    expect(r.statusCode).toBe(202);
    const msg = (await app.inject({ method: "GET", url: `/v1/messages/${r.json().message_id}`, headers: bearer(k) })).json();
    expect(msg.deliveries.map((d: { endpoint_id: string }) => d.endpoint_id)).toEqual([e1.id]);
  });
});
