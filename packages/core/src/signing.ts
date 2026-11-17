import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com).
 * Signed content: `${id}.${timestamp}.${body}`; signature: `v1,<base64 HMAC-SHA256>`.
 */

const PREFIX = "whsec_";

export function generateSecret(): string {
  return PREFIX + randomBytes(32).toString("base64");
}

export function secretKeyBytes(secret: string): Buffer {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  return Buffer.from(raw, "base64");
}

export function sign(secret: string, id: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secretKeyBytes(secret)).update(`${id}.${timestampSeconds}.${body}`).digest("base64");
  return `v1,${mac}`;
}

/** Headers for one delivery. Several active secrets (rotation) → several space-separated signatures. */
export function signatureHeaders(secrets: readonly string[], id: string, timestampSeconds: number, body: string): Record<string, string> {
  if (secrets.length === 0) throw new Error("at least one signing secret is required");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": secrets.map((s) => sign(s, id, timestampSeconds, body)).join(" "),
  };
}

export class WebhookVerificationError extends Error {}

export interface VerifyOptions {
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * Verify a received webhook. Accepts headers in any case. Throws WebhookVerificationError.
 * Returns the webhook id, which receivers should use for deduplication.
 */
export function verify(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  secret: string,
  opts: VerifyOptions = {},
): { id: string; timestamp: number } {
  const h = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
    }
    return undefined;
  };
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sigHeader = h("webhook-signature");
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError("missing webhook headers");

  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp)) throw new WebhookVerificationError("invalid timestamp");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError("timestamp outside tolerance");

  const expected = Buffer.from(sign(secret, id, timestamp, body).slice(3), "base64");
  for (const part of sigHeader.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { id, timestamp };
  }
  throw new WebhookVerificationError("no matching signature");
}
