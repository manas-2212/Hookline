import { describe, expect, it } from "vitest";
import { checkEndpointUrl, isBlockedIp, parseAllowlist } from "../src/index.js";

describe("SSRF block list", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918 upper edge"],
    ["192.168.1.1", "RFC 1918"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::7f00:1", "NAT64 (could reach 127.0.0.1)"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("lets an explicit allowlist override the block list", () => {
    const allow = parseAllowlist("127.0.0.1/32, 10.0.0.0/8");
    expect(isBlockedIp("127.0.0.1", allow)).toBe(false);
    expect(isBlockedIp("10.9.9.9", allow)).toBe(false);
    expect(isBlockedIp("127.0.0.2", allow)).toBe(true);
  });

  it("rejects bad allowlist entries", () => {
    expect(() => parseAllowlist("not-an-ip")).toThrow();
  });
});

describe("endpoint URL checks", () => {
  const strict = { allowInsecure: false };
  it("requires https unless insecure endpoints are allowed", () => {
    expect(checkEndpointUrl("http://example.com/hook", strict)).toEqual({ ok: false, problem: "scheme" });
    expect(checkEndpointUrl("http://example.com/hook", { allowInsecure: true }).ok).toBe(true);
    expect(checkEndpointUrl("ftp://example.com", { allowInsecure: true })).toEqual({ ok: false, problem: "scheme" });
  });
  it("rejects credentials, junk and blocked IP literals", () => {
    expect(checkEndpointUrl("https://u:p@example.com", strict)).toEqual({ ok: false, problem: "credentials" });
    expect(checkEndpointUrl("not a url", strict)).toEqual({ ok: false, problem: "invalid" });
    expect(checkEndpointUrl("https://169.254.169.254/latest", strict)).toEqual({ ok: false, problem: "blocked_ip" });
    expect(checkEndpointUrl("https://[::1]/x", strict)).toEqual({ ok: false, problem: "blocked_ip" });
    expect(checkEndpointUrl(`https://example.com/${"a".repeat(2100)}`, strict)).toEqual({ ok: false, problem: "too_long" });
  });
  it("accepts a normal https URL", () => {
    expect(checkEndpointUrl("https://api.example.com/webhooks?x=1", strict).ok).toBe(true);
  });
});
