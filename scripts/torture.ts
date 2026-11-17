/**
 * Torture test: real processes, real HTTP, real Postgres — then kill workers with SIGKILL while
 * they are mid-delivery and check that nothing was lost.
 *
 *   pnpm torture -- --messages 2000 --workers 3 --kill-every 4
 *
 * What runs:
 *   - a fresh database, the API, N worker processes, and the chaos receiver (all child processes)
 *   - four endpoints: healthy, flaky (30% 500s + latency), slow (300–800 ms), hostile
 *     (timeouts + connection resets + 20% 503s)
 *   - messages published through the HTTP API with bounded concurrency
 *   - every --kill-every seconds a random worker is SIGKILLed and a replacement started
 *
 * What it checks, per (endpoint, message) pair:
 *   lost       = never accepted by the receiver, although Hookline considers the delivery
 *                finished without giving up (succeeded/cancelled) — the bug we're hunting
 *   unfinished = still pending/in flight when the run ended (retry schedule not exhausted);
 *                reported separately and fails the run, because it means the run was too short
 *   duplicates = accepted more than once (the price of at-least-once; expected after kills)
 * Writes loadtests/results/<timestamp>/torture.{json,md}. The numbers are whatever this machine
 * produced; they are not targets.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApiKey, createApp, createTestDatabase } from "@hookline/db";
import { Hookline } from "@hookline/sdk";
import { sql } from "kysely";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    messages: { type: "string", default: "2000" },
    workers: { type: "string", default: "3" },
    "kill-every": { type: "string", default: "4" },
    concurrency: { type: "string", default: "32" },
    "retry-scale": { type: "string", default: "0.001" },
  },
});
const MESSAGES = Number(values.messages);
const WORKERS = Number(values.workers);
const KILL_EVERY_S = Number(values["kill-every"]);
const PUBLISH_CONCURRENCY = Number(values.concurrency);
const RX_PORT = 9310;
const API_PORT = 9311;

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`${url} did not come up`);
}

function start(name: string, cwd: string, env: Record<string, string>): ChildProcess {
  // Run node itself with tsx's loader rather than the `tsx` CLI: the CLI is a wrapper process,
  // and SIGKILL on a wrapper leaves the real worker running as an orphan. The PID we kill must
  // be the process doing the work.
  const tsx = join(ROOT, "node_modules/tsx/dist");
  const p = spawn(process.execPath, ["--require", join(tsx, "preflight.cjs"), "--import", pathToFileURL(join(tsx, "loader.mjs")).href, "src/main.ts"], {
    cwd: join(ROOT, cwd),
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  p.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line && !line.includes("ExperimentalWarning")) process.stderr.write(`[${name}] ${line.slice(0, 300)}\n`);
  });
  return p;
}

async function main() {
  const t = await createTestDatabase();
  const env = {
    DATABASE_URL: t.url,
    ALLOW_INSECURE_ENDPOINTS: "true",
    ENDPOINT_ALLOWLIST: "127.0.0.1/32",
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "2000",
    CONNECT_TIMEOUT_MS: "1000",
    LEASE_SECONDS: "5",
    REAP_EVERY_MS: "1000",
    RETRY_DELAY_SCALE: String(values["retry-scale"]),
    WORKER_CONCURRENCY: "48",
    ENDPOINT_MAX_IN_FLIGHT: "12",
    INGEST_RATE_PER_SEC: "100000",
    API_PORT: String(API_PORT),
    CHAOS_PORT: String(RX_PORT),
  };
  const procs = new Set<ChildProcess>();
  const rx = start("receiver", "apps/chaos-receiver", env);
  const api = start("api", "apps/api", env);
  procs.add(rx);
  procs.add(api);
  await Promise.all([waitFor(`http://127.0.0.1:${RX_PORT}/healthz`), waitFor(`http://127.0.0.1:${API_PORT}/readyz`)]);

  const app = await createApp(t.db, "torture");
  const key = (await createApiKey(t.db, app.id)).key;
  const h = new Hookline({ apiKey: key, baseUrl: `http://127.0.0.1:${API_PORT}` });
  const scenarios = {
    healthy: "name=healthy",
    flaky: "name=flaky&fail=0.3&latency=10-150",
    slow: "name=slow&latency=300-800",
    hostile: "name=hostile&timeout=0.05&reset=0.05&fail=0.2&latency=0-100",
  };
  const endpointIds: Record<string, string> = {};
  for (const [name, q] of Object.entries(scenarios)) {
    const e = await h.endpoints.create({ url: `http://127.0.0.1:${RX_PORT}/hook?${q}` });
    endpointIds[name] = e.id;
    await fetch(`http://127.0.0.1:${RX_PORT}/_control/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: e.secret }),
    });
  }

  const workers: ChildProcess[] = [];
  const spawnWorker = (i: number) => {
    const w = start(`worker${i}`, "apps/worker", { ...env, WORKER_METRICS_PORT: String(9400 + Math.floor(Math.random() * 500)) });
    procs.add(w);
    workers.push(w);
  };
  for (let i = 0; i < WORKERS; i++) spawnWorker(i);
  await sleep(1500);

  let kills = 0;
  let killing = KILL_EVERY_S > 0; // --kill-every 0 runs a baseline with no kills
  const killer = (async () => {
    while (killing) {
      await sleep(KILL_EVERY_S * 1000);
      if (!killing) break;
      const idx = Math.floor(Math.random() * workers.length);
      const victim = workers.splice(idx, 1)[0];
      if (!victim) continue;
      const exited = new Promise<boolean>((resolve) => {
        victim.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      victim.kill("SIGKILL");
      if (!(await exited)) throw new Error("a killed worker did not exit; the kill is not real");
      procs.delete(victim);
      kills++;
      log(`SIGKILL worker (kill #${kills}); starting a replacement`);
      spawnWorker(100 + kills);
    }
  })();

  log(`publishing ${MESSAGES} messages to 4 endpoints with ${WORKERS} workers…`);
  const started = Date.now();
  let next = 0;
  let published = 0;
  await Promise.all(
    Array.from({ length: PUBLISH_CONCURRENCY }, async () => {
      while (next < MESSAGES) {
        const i = next++;
        await h.messages.send("torture.event", { i, at: Date.now() }, { idempotencyKey: `t-${i}` });
        published++;
      }
    }),
  );
  const publishMs = Date.now() - started;
  log(`published ${published} in ${(publishMs / 1000).toFixed(1)} s`);

  // Keep killing while the queue drains, then let it settle.
  const drainStart = Date.now();
  for (;;) {
    const r = await sql<{ open: number }>`SELECT count(*)::int AS open FROM deliveries WHERE status IN ('pending','in_flight')`.execute(t.db);
    const open = r.rows[0]?.open ?? 0;
    if (open === 0) break;
    // The full retry schedule is ~23 h; scaled, plus margin for backlog. Waiting less would
    // misreport deliveries that are still legitimately retrying.
    if (Date.now() - drainStart > Math.max(10 * 60_000, 23 * 3_600_000 * Number(values["retry-scale"]) * 1.5 + 120_000)) {
      log("gave up waiting for the queue to drain");
      break;
    }
    await sleep(500);
  }
  killing = false;
  await killer;
  const totalMs = Date.now() - started;

  // ---- verify ----
  const ids = (await (await fetch(`http://127.0.0.1:${RX_PORT}/_control/ids`)).json()) as { ids: Array<{ name: string; id: string; count: number }> };
  const rxStats = (await (await fetch(`http://127.0.0.1:${RX_PORT}/_control/stats`)).json()) as { bad_signatures: number; requests: number };
  const accepted = new Map(ids.ids.map((x) => [`${x.name}|${x.id}`, x.count]));
  const deliveries = await sql<{ name: string; message_id: string; status: string; ttfa_ms: number | null; attempts: number }>`
    SELECT CASE e.id ${sql.join(
      Object.entries(endpointIds).map(([n, id]) => sql`WHEN ${id}::uuid THEN ${n}`),
      sql` `,
    )} END AS name,
           d.message_id, d.status, d.attempt_count AS attempts,
           extract(epoch FROM (d.first_attempt_at - d.created_at)) * 1000 AS ttfa_ms
    FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id`.execute(t.db);

  const per: Record<
    string,
    { expected: number; delivered: number; failed: number; lost: number; unfinished: number; duplicates: number; ttfa: number[]; attempts: number }
  > = {};
  for (const d of deliveries.rows) {
    const p = per[d.name] ?? { expected: 0, delivered: 0, failed: 0, lost: 0, unfinished: 0, duplicates: 0, ttfa: [], attempts: 0 };
    per[d.name] = p;
    p.expected++;
    p.attempts += d.attempts;
    if (d.ttfa_ms !== null) p.ttfa.push(Number(d.ttfa_ms));
    const n = accepted.get(`${d.name}|${d.message_id}`) ?? 0;
    if (n > 0) p.delivered++;
    if (n > 1) p.duplicates += n - 1;
    if (n === 0 && d.status === "failed") p.failed++;
    if (n === 0 && (d.status === "pending" || d.status === "in_flight")) p.unfinished++;
    if (n === 0 && (d.status === "succeeded" || d.status === "cancelled")) p.lost++;
  }
  const pct = (xs: number[], q: number) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0);
  };
  const totals = Object.values(per).reduce(
    (a, p) => ({
      expected: a.expected + p.expected,
      delivered: a.delivered + p.delivered,
      lost: a.lost + p.lost,
      unfinished: a.unfinished + p.unfinished,
      duplicates: a.duplicates + p.duplicates,
      failed: a.failed + p.failed,
    }),
    { expected: 0, delivered: 0, lost: 0, unfinished: 0, duplicates: 0, failed: 0 },
  );
  const report = {
    at: new Date().toISOString(),
    machine: { cpus: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), node: process.version },
    settings: { messages: MESSAGES, workers: WORKERS, kill_every_s: KILL_EVERY_S, retry_delay_scale: Number(values["retry-scale"]), lease_s: 5 },
    kills,
    publish_seconds: publishMs / 1000,
    total_seconds: totalMs / 1000,
    receiver_requests: rxStats.requests,
    bad_signatures: rxStats.bad_signatures,
    totals,
    endpoints: Object.fromEntries(
      Object.entries(per).map(([n, p]) => [
        n,
        {
          expected: p.expected,
          delivered: p.delivered,
          failed: p.failed,
          lost: p.lost,
          unfinished: p.unfinished,
          duplicates: p.duplicates,
          attempts: p.attempts,
          ttfa_p50_ms: pct(p.ttfa, 0.5),
          ttfa_p95_ms: pct(p.ttfa, 0.95),
        },
      ]),
    ),
  };

  const dir = join(ROOT, "loadtests/results", report.at.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "torture.json"), `${JSON.stringify(report, null, 2)}\n`);
  const rows = Object.entries(report.endpoints)
    .map(
      ([n, e]) =>
        `| ${n} | ${e.expected} | ${e.delivered} | ${e.failed} | **${e.lost}** | ${e.unfinished} | ${e.duplicates} | ${e.attempts} | ${e.ttfa_p50_ms ?? "–"} | ${e.ttfa_p95_ms ?? "–"} |`,
    )
    .join("\n");
  const md = `# Torture run ${report.at}

${MESSAGES} messages × 4 endpoints, ${WORKERS} workers, ${KILL_EVERY_S > 0 ? `a worker SIGKILLed every ${KILL_EVERY_S} s (${kills} kills)` : "no kills (baseline)"}.
Machine: ${report.machine.cpus} CPUs, ${report.machine.memory_gb} GB, Node ${report.machine.node}. Retry delays scaled ×${report.settings.retry_delay_scale}; lease 5 s.

**Lost: ${totals.lost}** · Unfinished: ${totals.unfinished} · Duplicates: ${totals.duplicates} · Bad signatures seen by receiver: ${report.bad_signatures} · Wall time: ${report.total_seconds.toFixed(1)} s

| Endpoint | Deliveries | Delivered | Failed (terminal) | Lost | Unfinished | Duplicates | Attempts | Time to first attempt p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
  await writeFile(join(dir, "torture.md"), md);
  console.log(`\n${md}\nwritten to ${dir}`);

  // Wait for every child to exit before dropping the database they are connected to.
  await Promise.all(
    [...procs].map(
      (p) =>
        new Promise<void>((resolve) => {
          if (p.exitCode !== null) return resolve();
          p.once("exit", () => resolve());
          p.kill("SIGKILL");
        }),
    ),
  );
  await t.drop();
  process.exit(totals.lost === 0 && totals.unfinished === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
