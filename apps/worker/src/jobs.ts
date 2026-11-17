import { DISABLE_AFTER_MS } from "@hookline/core";
import { type Db, deleteExpired, disableLongFailing, queueDepth, reapExpired } from "@hookline/db";
import type { Logger } from "pino";
import { queueDepthGauge, reapedTotal } from "./metrics.js";

/**
 * Periodic jobs. Each is idempotent, so running them on every worker replica is safe (just
 * redundant); no leader election needed.
 */
export function startJobs(db: Db, log: Logger, o: { retentionDays: number; reapEveryMs?: number }): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<void>) => {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running) return;
        running = true;
        fn()
          .catch((err) => log.error({ err, job: name }, "job failed"))
          .finally(() => {
            running = false;
          });
      }, ms),
    );
  };

  every(o.reapEveryMs ?? 10_000, "reaper", async () => {
    const n = await reapExpired(db);
    if (n > 0) {
      reapedTotal.inc(n);
      log.warn({ reaped: n }, "returned expired leases to the queue");
    }
  });
  every(60_000, "breaker", async () => {
    const disabled = await disableLongFailing(db, DISABLE_AFTER_MS);
    for (const d of disabled) log.warn({ endpoint_id: d.id }, "endpoint disabled after failing continuously");
  });
  every(3_600_000, "retention", async () => {
    const n = await deleteExpired(db, o.retentionDays);
    if (n > 0) log.info({ deleted: n }, "retention cleanup");
  });
  every(5_000, "queue-depth", async () => {
    const d = await queueDepth(db);
    for (const [status, n] of Object.entries(d)) queueDepthGauge.set({ status }, n);
  });
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
