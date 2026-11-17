/** Delay after attempt n (1-based) fails, before attempt n+1. 10 attempts total. */
export const RETRY_DELAYS_MS: readonly number[] = [
  5_000, // 5 s
  30_000, // 30 s
  2 * 60_000, // 2 m
  10 * 60_000, // 10 m
  30 * 60_000, // 30 m
  60 * 60_000, // 1 h
  3 * 3_600_000, // 3 h
  6 * 3_600_000, // 6 h
  12 * 3_600_000, // 12 h
];

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const JITTER = 0.2;
export const MAX_RETRY_AFTER_MS = 12 * 3_600_000;

export type Rng = () => number;

/**
 * Delay before the next attempt, or null if attempts are exhausted.
 * `attemptsMade` counts attempts already made (≥ 1). `retryAfterMs` comes from a 429/503 response.
 */
export function nextDelayMs(attemptsMade: number, rng: Rng = Math.random, retryAfterMs?: number | null): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS.at(attemptsMade - 1);
  if (base === undefined) return null;
  const jittered = Math.round(base * (1 - JITTER + rng() * 2 * JITTER));
  if (retryAfterMs != null && retryAfterMs > jittered) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  return jittered;
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds from now. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

export type AttemptErrorKind = "timeout" | "dns" | "connect" | "tls" | "http_status" | "redirect" | "ssrf_blocked" | "body_too_large";

export interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  errorKind: AttemptErrorKind | null;
}

export type Decision =
  | { kind: "succeeded" }
  | { kind: "retry"; delayMs: number }
  | { kind: "failed"; reason: "exhausted" | "ssrf_blocked" }
  | { kind: "endpoint_gone" };

/** The whole retry policy in one pure function. */
export function decide(outcome: AttemptOutcome, attemptsMade: number, rng: Rng = Math.random, retryAfterMs?: number | null): Decision {
  if (outcome.ok) return { kind: "succeeded" };
  if (outcome.errorKind === "ssrf_blocked") return { kind: "failed", reason: "ssrf_blocked" };
  if (outcome.status === 410) return { kind: "endpoint_gone" };
  const honorRetryAfter = outcome.status === 429 || outcome.status === 503 ? retryAfterMs : null;
  const delayMs = nextDelayMs(attemptsMade, rng, honorRetryAfter);
  return delayMs === null ? { kind: "failed", reason: "exhausted" } : { kind: "retry", delayMs };
}
