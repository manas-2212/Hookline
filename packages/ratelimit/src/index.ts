import { Redis } from "ioredis";

/** Result of asking for tokens: allowed, or how long to wait before trying again. */
export interface Take {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Take `cost` tokens from bucket `key` refilling at `ratePerSec`, holding at most `burst`. */
  take(key: string, ratePerSec: number, burst: number, cost?: number): Promise<Take>;
  close(): Promise<void>;
}

/** Pure token-bucket step, shared by both implementations so they behave identically. */
export function refill(
  state: { tokens: number; ts: number } | undefined,
  nowMs: number,
  ratePerSec: number,
  burst: number,
  cost: number,
): { state: { tokens: number; ts: number }; take: Take } {
  const prev = state ?? { tokens: burst, ts: nowMs };
  const tokens = Math.min(burst, prev.tokens + ((nowMs - prev.ts) / 1000) * ratePerSec);
  if (tokens >= cost) return { state: { tokens: tokens - cost, ts: nowMs }, take: { allowed: true, retryAfterMs: 0 } };
  const retryAfterMs = Math.ceil(((cost - tokens) / ratePerSec) * 1000);
  return { state: { tokens, ts: nowMs }, take: { allowed: false, retryAfterMs } };
}

/** Per-process limiter. Correct for one process; with several replicas each gets the full rate. */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  constructor(private now: () => number = Date.now) {}
  async take(key: string, ratePerSec: number, burst: number, cost = 1): Promise<Take> {
    const r = refill(this.buckets.get(key), this.now(), ratePerSec, burst, cost);
    this.buckets.set(key, r.state);
    if (this.buckets.size > 100_000) this.buckets.clear(); // crude memory bound
    return r.take;
  }
  async close(): Promise<void> {}
}

// Same algorithm as refill(), executed atomically inside Redis so all replicas share one bucket.
const LUA = `
local s = redis.call('HMGET', KEYS[1], 't', 'ts')
local rate = tonumber(ARGV[1]); local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3]); local cost = tonumber(ARGV[4])
local tokens = tonumber(s[1]) or burst
local ts = tonumber(s[2]) or now
tokens = math.min(burst, tokens + (now - ts) / 1000 * rate)
local allowed = 0
local wait = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else wait = math.ceil((cost - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 't', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {allowed, wait}`;

export class RedisRateLimiter implements RateLimiter {
  private redis: Redis;
  constructor(
    url: string,
    private now: () => number = Date.now,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.redis.defineCommand("hlTake", { numberOfKeys: 1, lua: LUA });
  }
  async take(key: string, ratePerSec: number, burst: number, cost = 1): Promise<Take> {
    const cmd = (this.redis as unknown as { hlTake: (k: string, ...a: number[]) => Promise<[number, number]> }).hlTake;
    const [allowed, wait] = await cmd.call(this.redis, `hl:rl:${key}`, ratePerSec, burst, this.now(), cost);
    return { allowed: allowed === 1, retryAfterMs: wait };
  }
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export function createRateLimiter(redisUrl: string | undefined): RateLimiter {
  return redisUrl ? new RedisRateLimiter(redisUrl) : new MemoryRateLimiter();
}
