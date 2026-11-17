import { verify } from "@hookline/sdk";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * A webhook receiver that misbehaves on purpose. Behaviour is chosen per endpoint URL, so one
 * receiver can play a healthy, a flaky and a dead endpoint at once:
 *
 *   /hook                         always 200
 *   /hook?fail=0.3                30% of requests get 500
 *   /hook?latency=50-400          random latency in ms (or a fixed value: latency=200)
 *   /hook?timeout=0.1             10% never answer (the sender's timeout fires)
 *   /hook?reset=0.05              5% of connections are destroyed mid-request
 *   /hook?fail_first=2            each webhook-id fails twice, then succeeds
 *   /hook?status=410              always answer this status
 *   /hook?status=429&retry_after=3
 *   /hook?name=sick               label used in stats
 *
 * Every request is recorded by webhook-id so tests can prove nothing was lost and count
 * duplicates. Signatures are verified against secrets registered at POST /_control/secrets.
 */

export interface ReceiverStats {
  requests: number;
  accepted: number;
  unique_accepted: number;
  duplicates: number;
  bad_signatures: number;
  by_name: Record<string, { requests: number; accepted: number }>;
}

export function buildReceiver(opts: { logger?: boolean; rng?: () => number } = {}): FastifyInstance {
  const rng = opts.rng ?? Math.random;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  const secrets = new Set<string>();
  const accepted = new Map<string, number>(); // `${name}|${webhook-id}` -> times answered 2xx
  const seenAttempts = new Map<string, number>(); // webhook-id -> requests seen (for fail_first)
  const firstAcceptedAt = new Map<string, number>();
  const stats: ReceiverStats = { requests: 0, accepted: 0, unique_accepted: 0, duplicates: 0, bad_signatures: 0, by_name: {} };

  // Keep the raw body: signatures are computed over the exact bytes sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/hook", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const name = q.name ?? "default";
    const id = String(req.headers["webhook-id"] ?? "");
    const raw = typeof req.body === "string" ? req.body : "";
    stats.requests++;
    const byName = stats.by_name[name] ?? { requests: 0, accepted: 0 };
    stats.by_name[name] = byName;
    byName.requests++;
    seenAttempts.set(id, (seenAttempts.get(id) ?? 0) + 1);

    if (secrets.size > 0) {
      const ok = [...secrets].some((s) => {
        try {
          verify(req.headers as Record<string, string>, raw, s);
          return true;
        } catch {
          return false;
        }
      });
      if (!ok) {
        stats.bad_signatures++;
        return reply.status(401).send({ error: "bad signature" });
      }
    }

    const latency = parseLatency(q.latency, rng);
    if (latency > 0) await sleep(latency);
    if (q.reset && rng() < Number(q.reset)) {
      req.raw.socket.destroy();
      return reply;
    }
    if (q.timeout && rng() < Number(q.timeout)) {
      await sleep(60_000);
      return reply.status(200).send({ late: true });
    }
    if (q.fail_first && (seenAttempts.get(id) ?? 0) <= Number(q.fail_first)) {
      return reply.status(500).send({ error: "failing on purpose (fail_first)" });
    }
    if (q.status) {
      if (q.retry_after) reply.header("retry-after", q.retry_after);
      const status = Number(q.status);
      if (status < 200 || status >= 300) return reply.status(status).send({ error: `status ${status} on purpose` });
    }
    if (q.fail && rng() < Number(q.fail)) return reply.status(500).send({ error: "random failure on purpose" });

    // One message fans out to several endpoints, so a delivery is identified by name + id.
    const key = `${name}|${id}`;
    const n = (accepted.get(key) ?? 0) + 1;
    accepted.set(key, n);
    stats.accepted++;
    byName.accepted++;
    if (n === 1) {
      stats.unique_accepted++;
      firstAcceptedAt.set(key, Date.now());
    } else stats.duplicates++;
    return reply.status(200).send({ ok: true });
  });

  app.post("/_control/secrets", async (req) => {
    const body = JSON.parse(String(req.body)) as { secret?: string };
    if (body.secret) secrets.add(body.secret);
    return { secrets: secrets.size };
  });
  app.get("/_control/stats", async () => stats);
  app.get("/_control/ids", async () => ({
    ids: [...accepted.entries()].map(([key, count]) => {
      const [name, id] = key.split("|");
      return { name, id, count };
    }),
  }));
  app.post("/_control/reset", async () => {
    accepted.clear();
    seenAttempts.clear();
    firstAcceptedAt.clear();
    Object.assign(stats, { requests: 0, accepted: 0, unique_accepted: 0, duplicates: 0, bad_signatures: 0, by_name: {} });
    return { ok: true };
  });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

function parseLatency(v: string | undefined, rng: () => number): number {
  if (!v) return 0;
  const [lo, hi] = v.split("-").map(Number);
  if (lo === undefined || Number.isNaN(lo)) return 0;
  if (hi === undefined || Number.isNaN(hi)) return lo;
  return lo + rng() * (hi - lo);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
