import { BlockList, isIP } from "node:net";

/**
 * SSRF guard. Destinations are checked after DNS resolution, and the worker connects to the
 * address that passed this check (see apps/worker transport), so DNS rebinding can't swap it.
 */

const BLOCKED_V4: ReadonlyArray<[string, number, string]> = [
  ["0.0.0.0", 8, "this network (RFC 1122)"],
  ["10.0.0.0", 8, "private (RFC 1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT (RFC 6598)"],
  ["127.0.0.0", 8, "loopback (RFC 1122)"],
  ["169.254.0.0", 16, "link-local, incl. cloud metadata (RFC 3927)"],
  ["172.16.0.0", 12, "private (RFC 1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments (RFC 6890)"],
  ["192.0.2.0", 24, "documentation TEST-NET-1 (RFC 5737)"],
  ["192.168.0.0", 16, "private (RFC 1918)"],
  ["198.18.0.0", 15, "benchmarking (RFC 2544)"],
  ["198.51.100.0", 24, "documentation TEST-NET-2 (RFC 5737)"],
  ["203.0.113.0", 24, "documentation TEST-NET-3 (RFC 5737)"],
  ["224.0.0.0", 4, "multicast (RFC 5771)"],
  ["240.0.0.0", 4, "reserved, incl. broadcast (RFC 1112)"],
];

const BLOCKED_V6: ReadonlyArray<[string, number, string]> = [
  ["::", 128, "unspecified (RFC 4291)"],
  ["::1", 128, "loopback (RFC 4291)"],
  ["64:ff9b::", 96, "NAT64 (RFC 6052)"],
  ["100::", 64, "discard-only (RFC 6666)"],
  ["2001:db8::", 32, "documentation (RFC 3849)"],
  ["fc00::", 7, "unique local (RFC 4193)"],
  ["fe80::", 10, "link-local (RFC 4291)"],
  ["ff00::", 8, "multicast (RFC 4291)"],
];

const blocked = new BlockList();
for (const [addr, prefix] of BLOCKED_V4) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of BLOCKED_V6) blocked.addSubnet(addr, prefix, "ipv6");

export const BLOCKED_RANGES = [...BLOCKED_V4, ...BLOCKED_V6].map(([a, p, why]) => ({ cidr: `${a}/${p}`, why }));

export function parseAllowlist(csv: string): BlockList {
  const list = new BlockList();
  for (const raw of csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [addr, prefixStr] = raw.split("/");
    if (!addr) continue;
    const family = isIP(addr);
    if (family === 0) throw new Error(`invalid allowlist entry: ${raw}`);
    const prefix = prefixStr === undefined ? (family === 4 ? 32 : 128) : Number(prefixStr);
    list.addSubnet(addr, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/** Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so it is judged as the IPv4 address it is. */
export function normalizeIp(ip: string): { address: string; family: 4 | 6 } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return { address: mapped[1], family: 4 };
  const fam = isIP(ip);
  if (fam === 0) throw new Error(`not an IP address: ${ip}`);
  return { address: ip, family: fam as 4 | 6 };
}

export function isBlockedIp(ip: string, allowlist?: BlockList): boolean {
  const { address, family } = normalizeIp(ip);
  const type = family === 4 ? "ipv4" : "ipv6";
  if (allowlist?.check(address, type)) return false;
  return blocked.check(address, type);
}

export type UrlProblem = "invalid" | "scheme" | "credentials" | "too_long" | "blocked_ip";

/** Static checks done when an endpoint is created (DNS checks happen at send time). */
export function checkEndpointUrl(
  raw: string,
  opts: { allowInsecure: boolean; allowlist?: BlockList },
): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  if (raw.length > 2048) return { ok: false, problem: "too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  const schemeOk = url.protocol === "https:" || (opts.allowInsecure && url.protocol === "http:");
  if (!schemeOk) return { ok: false, problem: "scheme" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedIp(host, opts.allowlist)) return { ok: false, problem: "blocked_ip" };
  return { ok: true, url };
}
