import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM envelope: [12-byte IV | 16-byte tag | ciphertext]. */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

/** API keys: `hk_` + 32 random bytes (base64url). Stored as SHA-256; lookup is by hash, so no timing leak on compare. */
export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const key = `hk_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}

/** Stable hash of a request body for idempotency comparison. */
export function requestHash(eventType: string, payload: unknown): Buffer {
  return sha256(`${eventType}\n${canonicalJson(payload)}`);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
