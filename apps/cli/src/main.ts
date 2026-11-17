#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Hookline, HooklineError, type LiveEvent } from "@hookline/sdk";
import { WebSocket } from "ws";

/**
 * hookline — command-line companion.
 *
 *   hookline login --api-key hk_… [--url http://localhost:8080]
 *   hookline send <event_type> '<json>' [--idempotency-key k]
 *   hookline endpoints
 *   hookline tail                         live stream of attempts and messages
 *   hookline listen --forward-to http://localhost:3000/webhooks [--events a,b]
 *   hookline replay <endpoint_id> --since 1h [--only-failed]
 */

const CONFIG = join(homedir(), ".config", "hookline", "config.json");
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Saved {
  apiKey?: string;
  url?: string;
}

async function loadSaved(): Promise<Saved> {
  try {
    return JSON.parse(await readFile(CONFIG, "utf8")) as Saved;
  } catch {
    return {};
  }
}

async function client(): Promise<Hookline> {
  const saved = await loadSaved();
  const apiKey = process.env.HOOKLINE_API_KEY ?? saved.apiKey;
  if (!apiKey) die("no API key: run `hookline login --api-key hk_…` or set HOOKLINE_API_KEY");
  return new Hookline({ apiKey, baseUrl: process.env.HOOKLINE_URL ?? saved.url ?? "http://localhost:8080" });
}

function die(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

const time = () => c.dim(new Date().toLocaleTimeString());
const statusColor = (s: number | null | undefined) =>
  s == null ? c.red("ERR") : s < 300 ? c.green(String(s)) : s < 500 ? c.yellow(String(s)) : c.red(String(s));

function parseDuration(v: string): Date {
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m?.[1] || !m[2]) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) die(`invalid --since: ${v} (use 30m, 2h, 1d or an ISO date)`);
    return d;
  }
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "s" | "m" | "h" | "d"];
  return new Date(Date.now() - Number(m[1]) * unit);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "api-key": { type: "string" },
      url: { type: "string" },
      "idempotency-key": { type: "string" },
      "forward-to": { type: "string" },
      events: { type: "string" },
      endpoint: { type: "string" },
      since: { type: "string" },
      "only-failed": { type: "boolean" },
    },
  });

  switch (cmd) {
    case "login": {
      if (!values["api-key"]) die("--api-key is required");
      await mkdir(join(homedir(), ".config", "hookline"), { recursive: true });
      await writeFile(CONFIG, JSON.stringify({ apiKey: values["api-key"], url: values.url ?? "http://localhost:8080" }, null, 2), { mode: 0o600 });
      console.log(c.green(`saved to ${CONFIG}`));
      return;
    }
    case "send": {
      const [type, json] = positionals;
      if (!type) die("usage: hookline send <event_type> '<json>'");
      let payload: unknown = {};
      try {
        payload = json ? JSON.parse(json) : {};
      } catch {
        die("payload must be valid JSON");
      }
      const h = await client();
      const r = await h.messages.send(type, payload, { idempotencyKey: values["idempotency-key"] });
      console.log(`${c.green("✓")} ${r.id}  ${c.dim(`→ ${r.deliveries ?? "?"} endpoint(s)`)}`);
      return;
    }
    case "endpoints": {
      const h = await client();
      const { items } = await h.endpoints.list();
      for (const e of items as Array<Record<string, string | number | null>>) {
        const health = Number(e.attempts_24h) > 0 ? `${Math.round((Number(e.succeeded_24h) / Number(e.attempts_24h)) * 100)}% ok 24h` : "no traffic";
        console.log(`${c.bold(String(e.id))}  ${e.kind === "relay" ? c.cyan("relay") : String(e.url)}  ${e.status}  ${c.dim(health)}`);
      }
      return;
    }
    case "tail": {
      const h = await client();
      console.log(c.dim(`streaming live events from ${h.baseUrl} — Ctrl-C to stop`));
      await h.live((e: LiveEvent) => {
        if (e.kind === "message") console.log(`${time()} ${c.cyan("→ message")} ${e.message_id} ${c.dim(e.event_type ?? "")}`);
        else if (e.kind === "attempt")
          console.log(
            `${time()} ${statusColor(e.response_status)} ${e.message_id} ${c.dim(`#${e.attempt_no} ${e.duration_ms}ms`)} ${
              e.status === "pending" ? c.yellow("retry scheduled") : e.status === "failed" ? c.red("failed") : ""
            }${e.error_kind ? c.red(` ${e.error_kind}`) : ""}`,
          );
        else console.log(`${time()} ${c.yellow("endpoint")} ${e.endpoint_id} ${e.status}`);
      });
      return;
    }
    case "listen":
      return listen(values["forward-to"], values.events, values.endpoint);
    case "replay": {
      const [endpointId] = positionals;
      if (!endpointId || !values.since) die("usage: hookline replay <endpoint_id> --since 1h [--only-failed]");
      const h = await client();
      const r = await h.endpoints.replay(endpointId, { since: parseDuration(values.since), only_failed: Boolean(values["only-failed"]) });
      console.log(`${c.green("✓")} queued ${r.queued} deliveries`);
      return;
    }
    default:
      console.log(`hookline — reliable webhooks from your terminal

  login --api-key hk_… [--url URL]      save credentials
  send <event_type> '<json>'            publish an event
  endpoints                             list endpoints with 24h health
  tail                                  live stream of deliveries
  listen --forward-to URL [--events a,b] [--endpoint id]
                                        receive webhooks on localhost, no tunnel needed
  replay <endpoint_id> --since 1h       re-deliver recent messages`);
  }
}

/**
 * `hookline listen`: creates (or reuses) a relay endpoint and holds a WebSocket to the API.
 * Deliveries arrive down the socket, are forwarded to --forward-to, and the result goes back up.
 * Retries, signing and the attempt log behave exactly as for a public HTTPS endpoint.
 */
async function listen(forwardTo: string | undefined, events: string | undefined, endpointId: string | undefined) {
  if (!forwardTo) die("--forward-to is required, e.g. --forward-to http://localhost:3000/webhooks");
  const h = await client();
  let id = endpointId;
  if (!id) {
    const created = await h.endpoints.create({
      kind: "relay",
      description: `hookline listen → ${forwardTo}`,
      event_types: events ? events.split(",").map((s) => s.trim()) : undefined,
    });
    id = created.id;
    console.log(`${c.bold("relay endpoint")} ${id}`);
    console.log(`${c.bold("signing secret")} ${created.secret}  ${c.dim("(verify with @hookline/sdk)")}`);
  }
  const wsUrl = `${h.baseUrl.replace(/^http/, "ws")}/v1/relay/${id}`;
  const saved = await loadSaved();
  const apiKey = process.env.HOOKLINE_API_KEY ?? saved.apiKey ?? "";

  const connect = (attempt = 0) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${apiKey}` } });
    ws.on("open", () => console.log(`${time()} ${c.green("connected")} forwarding to ${c.bold(forwardTo)} — Ctrl-C to stop`));
    ws.on("message", async (data) => {
      const m = JSON.parse(String(data)) as {
        type: string;
        delivery_id: string;
        attempt_no: number;
        event_type: string;
        headers: Record<string, string>;
        body: string;
        message?: string;
      };
      if (m.type === "error") die(m.message ?? "relay error");
      if (m.type !== "delivery") return;
      const started = performance.now();
      let status: number | null = null;
      let body: string | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(forwardTo, { method: "POST", headers: m.headers, body: m.body, signal: AbortSignal.timeout(14_000) });
        status = res.status;
        body = (await res.text()).slice(0, 4096);
      } catch (e) {
        error = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message;
      }
      const ms = Math.round(performance.now() - started);
      console.log(`${time()} ${statusColor(status)} ${m.event_type} ${c.dim(`#${m.attempt_no} ${ms}ms`)}${error ? c.red(` ${error}`) : ""}`);
      ws.send(JSON.stringify({ type: "result", delivery_id: m.delivery_id, status, duration_ms: ms, body, error }));
    });
    ws.on("close", (code) => {
      if (code === 4404) die("relay endpoint not found");
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.log(`${time()} ${c.yellow(`disconnected; reconnecting in ${wait / 1000}s`)}`);
      setTimeout(() => connect(attempt + 1), wait);
    });
    ws.on("error", () => {
      /* close handler reconnects */
    });
  };
  connect();
}

main().catch((e) => {
  if (e instanceof HooklineError) die(e.message);
  die((e as Error).message);
});
