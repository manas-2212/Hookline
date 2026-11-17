import { describe, expect, it } from "vitest";
import { generateSecret, sign, signatureHeaders, verify, WebhookVerificationError } from "../src/index.js";

describe("Standard Webhooks signing", () => {
  // Test vector published with the Standard Webhooks specification.
  it("matches the published test vector", () => {
    const sig = sign("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("round-trips sign → verify", () => {
    const secret = generateSecret();
    const now = 1_700_000_000;
    const h = signatureHeaders([secret], "msg_1", now, '{"a":1}');
    expect(verify(h, '{"a":1}', secret, { nowSeconds: now })).toEqual({ id: "msg_1", timestamp: now });
  });

  it("rejects a tampered body", () => {
    const secret = generateSecret();
    const h = signatureHeaders([secret], "msg_1", 100, '{"a":1}');
    expect(() => verify(h, '{"a":2}', secret, { nowSeconds: 100 })).toThrow(WebhookVerificationError);
  });

  it("rejects timestamps outside the tolerance (replay protection)", () => {
    const secret = generateSecret();
    const h = signatureHeaders([secret], "msg_1", 1000, "{}");
    expect(() => verify(h, "{}", secret, { nowSeconds: 1000 + 301 })).toThrow(/tolerance/);
    expect(() => verify(h, "{}", secret, { nowSeconds: 1000 + 299 })).not.toThrow();
  });

  it("accepts any of several signatures during secret rotation", () => {
    const oldS = generateSecret();
    const newS = generateSecret();
    const h = signatureHeaders([newS, oldS], "msg_1", 50, "{}");
    expect(h["webhook-signature"]?.split(" ")).toHaveLength(2);
    expect(() => verify(h, "{}", oldS, { nowSeconds: 50 })).not.toThrow();
    expect(() => verify(h, "{}", newS, { nowSeconds: 50 })).not.toThrow();
    expect(() => verify(h, "{}", generateSecret(), { nowSeconds: 50 })).toThrow();
  });

  it("is case-insensitive about header names and requires all three", () => {
    const s = generateSecret();
    const h = signatureHeaders([s], "msg_1", 10, "{}");
    const upper = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toUpperCase(), v]));
    expect(() => verify(upper, "{}", s, { nowSeconds: 10 })).not.toThrow();
    expect(() => verify({ "webhook-id": "x" }, "{}", s)).toThrow(/missing/);
  });
});
