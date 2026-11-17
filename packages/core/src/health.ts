/**
 * Endpoint circuit breaker. Pure: callers pass counters, get back the concurrency the endpoint
 * deserves and whether it should be disabled.
 */
export const DEGRADE_AFTER_FAILURES = 5;
export const DISABLE_AFTER_MS = 5 * 24 * 3_600_000;

export type BreakerState = "closed" | "degraded" | "open";

export function breakerState(consecutiveFailures: number, lastSuccessAt: Date | null, createdAt: Date, now: Date): BreakerState {
  if (consecutiveFailures < DEGRADE_AFTER_FAILURES) return "closed";
  const since = (lastSuccessAt ?? createdAt).getTime();
  return now.getTime() - since >= DISABLE_AFTER_MS ? "open" : "degraded";
}

/** Concurrency cap for an endpoint given its breaker state. */
export function concurrencyFor(state: BreakerState, normalCap: number): number {
  return state === "closed" ? normalCap : state === "degraded" ? 1 : 0;
}

/** 0–100 score shown in the dashboard: success share of recent attempts, penalised by streaks. */
export function healthScore(succeeded: number, total: number, consecutiveFailures: number): number | null {
  if (total === 0) return null;
  const base = (succeeded / total) * 100;
  const penalty = Math.min(40, consecutiveFailures * 4);
  return Math.max(0, Math.round(base - penalty));
}
