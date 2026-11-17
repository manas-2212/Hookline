import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  breakerState,
  canonicalJson,
  concurrencyFor,
  decrypt,
  encrypt,
  generateApiKey,
  healthScore,
  newMessageId,
  parseTraceparent,
  requestHash,
  sha256,
  snippet,
} from "../src/index.js";

describe("secret encryption", () => {
  const key = randomBytes(32);
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("whsec_abc", key);
    const b = encrypt("whsec_abc", key);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, key)).toBe("whsec_abc");
    expect(a.toString("utf8")).not.toContain("whsec_abc");
  });
  it("detects tampering (GCM auth tag)", () => {
    const blob = encrypt("whsec_abc", key);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(blob, key)).toThrow();
  });
  it("fails with the wrong key", () => {
    expect(() => decrypt(encrypt("x", key), randomBytes(32))).toThrow();
  });
});

describe("ids, keys and hashes", () => {
  it("issues hk_ keys and stores only a hash", () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^hk_[A-Za-z0-9_-]{43}$/);
    expect(k.hash.equals(sha256(k.key))).toBe(true);
    expect(k.prefix).toBe(k.key.slice(0, 10));
  });
  it("makes sortable message ids", () => {
    const a = newMessageId();
    const b = newMessageId();
    expect(a < b).toBe(true);
    expect(a).toMatch(/^msg_[0-9A-Z]{26}$/);
  });
  it("hashes requests independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(requestHash("t", { a: 1, b: 2 }).equals(requestHash("t", { b: 2, a: 1 }))).toBe(true);
    expect(requestHash("t", { a: 1 }).equals(requestHash("u", { a: 1 }))).toBe(false);
  });
  it("truncates response snippets by bytes", () => {
    expect(snippet("abc", 10)).toBe("abc");
    expect(snippet("a".repeat(20), 10)).toBe(`${"a".repeat(10)}…`);
    expect(snippet(null, 10)).toBeNull();
  });
  it("parses W3C traceparent", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
  });
});

describe("circuit breaker", () => {
  const created = new Date("2026-01-01T00:00:00Z");
  const day = 86_400_000;
  it("stays closed below 5 consecutive failures", () => {
    expect(breakerState(4, null, created, new Date(created.getTime() + 10 * day))).toBe("closed");
  });
  it("degrades to one request at a time, then opens after 5 days without success", () => {
    const lastOk = new Date(created.getTime() + day);
    expect(breakerState(5, lastOk, created, new Date(lastOk.getTime() + 4 * day))).toBe("degraded");
    expect(breakerState(5, lastOk, created, new Date(lastOk.getTime() + 5 * day))).toBe("open");
    expect(concurrencyFor("closed", 8)).toBe(8);
    expect(concurrencyFor("degraded", 8)).toBe(1);
    expect(concurrencyFor("open", 8)).toBe(0);
  });
  it("scores health", () => {
    expect(healthScore(0, 0, 0)).toBeNull();
    expect(healthScore(100, 100, 0)).toBe(100);
    expect(healthScore(90, 100, 5)).toBe(70);
  });
});
