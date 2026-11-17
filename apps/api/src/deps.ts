import type { Config } from "@hookline/config";
import type { Db, Pool } from "@hookline/db";
import type { RateLimiter } from "@hookline/ratelimit";
import type { EventHub } from "./hub.js";

export interface Deps {
  cfg: Config;
  db: Db;
  pool: Pool;
  limiter: RateLimiter;
  hub: EventHub;
  encKey: Buffer;
  /** Test hooks. Never set in production code paths. */
  hooks?: { afterMessageInsert?: () => void | Promise<void> };
}
