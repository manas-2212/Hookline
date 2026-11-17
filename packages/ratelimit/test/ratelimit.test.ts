import { describe, expect, it } from "vitest";
import { MemoryRateLimiter, RedisRateLimiter, refill } from "../src/index.js";

describe("token bucket", () => {
  it("allows a burst, then refills at the configured rate", () => {
    let s: { tokens: number; ts: number } | undefined;
    const take = (now: number) => {
      const r = refill(s, now, 10, 5, 1);
      s = r.state;
      return r.take;
    };
    for (let i = 0; i < 5; i++) expect(take(0).allowed).toBe(true);
    const denied = take(0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(100); // 1 token at 10/s
    expect(take(100).allowed).toBe(true);
    expect(take(100).allowed).toBe(false);
  });

  it("never stores more than the burst", () => {
    const r = refill({ tokens: 0, ts: 0 }, 60_000, 10, 5, 1);
    expect(r.state.tokens).toBe(4);
  });

  it("memory limiter keeps buckets separate per key", async () => {
    let now = 0;
    const m = new MemoryRateLimiter(() => now);
    expect((await m.take("a", 1, 1)).allowed).toBe(true);
    expect((await m.take("a", 1, 1)).allowed).toBe(false);
    expect((await m.take("b", 1, 1)).allowed).toBe(true);
    now = 1000;
    expect((await m.take("a", 1, 1)).allowed).toBe(true);
  });

  it.skipIf(!process.env.REDIS_URL)("redis limiter matches the pure algorithm", async () => {
    let now = 1_000_000;
    const r = new RedisRateLimiter(process.env.REDIS_URL as string, () => now);
    const key = `test:${Math.random()}`;
    try {
      for (let i = 0; i < 3; i++) expect((await r.take(key, 2, 3)).allowed).toBe(true);
      const d = await r.take(key, 2, 3);
      expect(d).toEqual({ allowed: false, retryAfterMs: 500 });
      now += 500;
      expect((await r.take(key, 2, 3)).allowed).toBe(true);
    } finally {
      await r.close();
    }
  });
});
