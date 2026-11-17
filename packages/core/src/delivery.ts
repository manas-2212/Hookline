import { type AttemptOutcome, type Decision, decide, type Rng } from "./retry.js";

/**
 * The decision for a just-finished attempt, given the delivery's counters. Retry cycles:
 * `attempt_count - retry_base` attempts were made in the current cycle before this one.
 * Shared by the HTTP worker and the CLI relay so both follow one policy.
 */
export function decideForDelivery(
  counters: { attempt_count: number; retry_base: number },
  outcome: AttemptOutcome,
  rng: Rng = Math.random,
  retryAfterMs?: number | null,
): Decision {
  const attemptsInCycle = counters.attempt_count - counters.retry_base + 1;
  return decide(outcome, attemptsInCycle, rng, retryAfterMs);
}

/** Cap stored response bodies; keeps the attempts table small. */
export function snippet(body: string | null, maxBytes: number): string | null {
  if (body === null) return null;
  const buf = Buffer.from(body, "utf8");
  return buf.length <= maxBytes ? body : `${buf.subarray(0, maxBytes).toString("utf8")}…`;
}
