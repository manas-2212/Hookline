import { describe, expect, it } from "vitest";
import { decide, decideForDelivery, JITTER, MAX_ATTEMPTS, nextDelayMs, parseRetryAfter, RETRY_DELAYS_MS } from "../src/index.js";

const fail = { ok: false, status: 500, errorKind: "http_status" as const };

describe("retry schedule", () => {
  it("makes 10 attempts in total, about 23 hours end to end", () => {
    expect(MAX_ATTEMPTS).toBe(10);
    const totalH = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 3_600_000;
    expect(totalH).toBeGreaterThan(22);
    expect(totalH).toBeLessThan(24);
  });

  it("keeps jitter within ±20% of the base delay", () => {
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      const base = RETRY_DELAYS_MS[n - 1] as number;
      expect(nextDelayMs(n, () => 0)).toBe(Math.round(base * (1 - JITTER)));
      expect(nextDelayMs(n, () => 1)).toBe(Math.round(base * (1 + JITTER)));
    }
  });

  it("stops after the 10th attempt", () => {
    expect(nextDelayMs(9, () => 0.5)).not.toBeNull();
    expect(nextDelayMs(10, () => 0.5)).toBeNull();
    expect(decide(fail, 10)).toEqual({ kind: "failed", reason: "exhausted" });
  });

  it("succeeds on any 2xx", () => {
    expect(decide({ ok: true, status: 204, errorKind: null }, 3)).toEqual({ kind: "succeeded" });
  });

  it("treats 410 Gone as the endpoint asking to be removed", () => {
    expect(decide({ ok: false, status: 410, errorKind: "http_status" }, 1)).toEqual({ kind: "endpoint_gone" });
  });

  it("never retries an SSRF-blocked destination", () => {
    expect(decide({ ok: false, status: null, errorKind: "ssrf_blocked" }, 1)).toEqual({ kind: "failed", reason: "ssrf_blocked" });
  });

  it("honours a longer Retry-After on 429 and 503 only", () => {
    const hour = 3_600_000;
    expect(decide({ ok: false, status: 429, errorKind: "http_status" }, 1, () => 0.5, hour)).toEqual({ kind: "retry", delayMs: hour });
    expect(decide({ ok: false, status: 503, errorKind: "http_status" }, 1, () => 0.5, hour)).toEqual({ kind: "retry", delayMs: hour });
    expect(decide({ ok: false, status: 500, errorKind: "http_status" }, 1, () => 0.5, hour)).toEqual({ kind: "retry", delayMs: 5000 });
    // a shorter Retry-After never shortens the schedule
    expect(decide({ ok: false, status: 429, errorKind: "http_status" }, 3, () => 0.5, 1000)).toEqual({ kind: "retry", delayMs: 120_000 });
  });

  it("caps Retry-After at 12 hours", () => {
    expect(nextDelayMs(1, () => 0.5, 48 * 3_600_000)).toBe(12 * 3_600_000);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("restarts the schedule for a new retry cycle (manual retry/replay)", () => {
    // 10 attempts already made, but a manual retry set retry_base = 10: this is attempt 1 of a new cycle.
    expect(decideForDelivery({ attempt_count: 10, retry_base: 10 }, fail, () => 0.5)).toEqual({ kind: "retry", delayMs: 5000 });
    expect(decideForDelivery({ attempt_count: 9, retry_base: 0 }, fail, () => 0.5)).toEqual({ kind: "failed", reason: "exhausted" });
  });
});
