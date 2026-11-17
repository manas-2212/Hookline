import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseAllowlist } from "@hookline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, HttpTransport } from "../src/transport.js";

type Resolver = (h: string, o: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => void;
const fakeDns =
  (map: Record<string, string>): Resolver =>
  (host, _o, cb) => {
    const ip = map[host];
    if (!ip) return cb(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
  };

let server: Server;
let port: number;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") return res.writeHead(302, { location: "http://example.com" }).end();
    if (req.url === "/slow") return void setTimeout(() => res.end("late"), 2000);
    if (req.url === "/429") return res.writeHead(429, { "retry-after": "7" }).end("slow down");
    if (req.url === "/big") return res.end("x".repeat(100_000));
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const make = (dns: Record<string, string>, allow = "") =>
  new HttpTransport({
    connectTimeoutMs: 1000,
    requestTimeoutMs: 500,
    allowlist: parseAllowlist(allow),
    resolver: fakeDns(dns) as never,
  });

describe("HttpTransport SSRF protection", () => {
  it("refuses a hostname that resolves to a private address, at connect time", async () => {
    const t = make({ "evil.example": "127.0.0.1" });
    const r = await t.send(`http://evil.example:${port}/`, {}, "{}");
    expect(r.errorKind).toBe("ssrf_blocked");
    await t.close();
  });

  it("refuses blocked IP literals without any DNS lookup", async () => {
    const t = make({});
    const r = await t.send("http://169.254.169.254/latest/meta-data", {}, "{}");
    expect(r.errorKind).toBe("ssrf_blocked");
    await t.close();
  });

  it("connects when the resolved address is allowlisted", async () => {
    const t = make({ "receiver.test": "127.0.0.1" }, "127.0.0.1/32");
    const r = await t.send(`http://receiver.test:${port}/`, {}, "{}");
    expect(r).toMatchObject({ ok: true, status: 200, body: "ok" });
    await t.close();
  });
});

describe("HttpTransport outcomes", () => {
  const t = () => make({ "r.test": "127.0.0.1" }, "127.0.0.1/32");
  it("does not follow redirects", async () => {
    const r = await t().send(`http://r.test:${port}/redirect`, {}, "{}");
    expect(r).toMatchObject({ ok: false, status: 302, errorKind: "redirect" });
  });
  it("times out slow endpoints", async () => {
    const r = await t().send(`http://r.test:${port}/slow`, {}, "{}");
    expect(r.errorKind).toBe("timeout");
    expect(r.durationMs).toBeLessThan(1500);
  });
  it("reads Retry-After", async () => {
    const r = await t().send(`http://r.test:${port}/429`, {}, "{}");
    expect(r).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });
  it("keeps only a 4 KB snippet of large bodies", async () => {
    const r = await t().send(`http://r.test:${port}/big`, {}, "{}");
    expect(r.body?.length).toBe(4096);
  });
  it("reports DNS failures", async () => {
    const r = await t().send(`http://nope.test:${port}/`, {}, "{}");
    expect(r.errorKind).toBe("dns");
  });
  it("reports refused connections", async () => {
    const r = await t().send("http://r.test:1/", {}, "{}");
    expect(r.errorKind).toBe("connect");
  });
});

describe("classify", () => {
  it("maps error codes to attempt error kinds", () => {
    expect(classify(Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" })).kind).toBe("timeout");
    expect(classify(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" })).kind).toBe("tls");
    expect(classify(Object.assign(new Error("x"), { code: "EAI_AGAIN" })).kind).toBe("dns");
  });
});
