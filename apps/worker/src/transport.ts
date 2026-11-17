import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { type BlockList, isIP } from "node:net";
import { type AttemptErrorKind, isBlockedIp, parseRetryAfter, RESPONSE_SNIPPET_BYTES } from "@hookline/core";
import { Agent, request } from "undici";

export class SsrfBlockedError extends Error {
  code = "HOOKLINE_SSRF_BLOCKED";
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  errorKind: AttemptErrorKind | null;
  errorDetail: string | null;
  body: string | null;
  retryAfterMs: number | null;
  durationMs: number;
}

export interface TransportOptions {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  allowlist?: BlockList;
  /** Injectable DNS for tests. */
  resolver?: typeof dnsLookup;
}

/**
 * HTTP transport with SSRF protection that survives DNS rebinding: the check runs inside the
 * socket's own DNS lookup, so the address that passed the check is exactly the one connected to.
 */
export class HttpTransport {
  private agent: Agent;

  constructor(private o: TransportOptions) {
    const resolve = o.resolver ?? dnsLookup;
    const guardedLookup: LookupFunction = (hostname, options, callback) => {
      resolve(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = (addresses as unknown as LookupAddress[]).filter((a) => !isBlockedIp(a.address, o.allowlist));
        if (list.length === 0) return callback(new SsrfBlockedError(`${hostname} resolves only to blocked addresses`), "", 4);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        const first = list[0] as LookupAddress; // safe: list.length > 0 checked above
        callback(null, first.address, first.family);
      });
    };
    this.agent = new Agent({
      connect: { lookup: guardedLookup, timeout: o.connectTimeoutMs },
      headersTimeout: o.requestTimeoutMs,
      bodyTimeout: o.requestTimeoutMs,
      keepAliveTimeout: 10_000,
      connections: 64,
    });
  }

  async send(url: string, headers: Record<string, string>, body: string): Promise<SendResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      // An IP-literal host never goes through DNS lookup, so check it here.
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isBlockedIp(host, this.o.allowlist)) throw new SsrfBlockedError(`${host} is a blocked address`);

      const res = await request(url, {
        method: "POST",
        headers,
        body,
        dispatcher: this.agent,
        signal: AbortSignal.timeout(this.o.requestTimeoutMs),
      });
      const text = await readCapped(res.body, RESPONSE_SNIPPET_BYTES);
      const status = res.statusCode;
      const retryAfter = res.headers["retry-after"];
      const ok = status >= 200 && status < 300;
      return {
        ok,
        status,
        errorKind: ok ? null : status >= 300 && status < 400 ? "redirect" : "http_status",
        errorDetail: ok ? null : status >= 300 && status < 400 ? "redirects are not followed" : null,
        body: text,
        retryAfterMs: parseRetryAfter(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter),
        durationMs: elapsed(),
      };
    } catch (err) {
      const { kind, detail } = classify(err);
      return { ok: false, status: null, errorKind: kind, errorDetail: detail, body: null, retryAfterMs: null, durationMs: elapsed() };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}

async function readCapped(stream: AsyncIterable<Buffer> & { destroy?: () => void }, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= max) {
      stream.destroy?.(); // stop reading: we only keep a snippet
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

export function classify(err: unknown): { kind: AttemptErrorKind; detail: string } {
  const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  const detail = `${code ? `${code}: ` : ""}${e.cause?.message ?? e.message ?? String(err)}`.slice(0, 500);
  if (err instanceof SsrfBlockedError || code === "HOOKLINE_SSRF_BLOCKED" || e.cause instanceof SsrfBlockedError) {
    return { kind: "ssrf_blocked", detail };
  }
  if (e.name === "TimeoutError" || e.name === "AbortError" || /TIMEOUT/.test(code)) return { kind: "timeout", detail };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return { kind: "dns", detail };
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { kind: "tls", detail };
  return { kind: "connect", detail };
}
