# ADR 0005: Fair claiming with per-endpoint in-flight caps

**Status:** accepted

## Context

The naive queue claim, "the N oldest due rows, `FOR UPDATE SKIP LOCKED`", lets one endpoint with
a large backlog fill every batch. If that endpoint is also slow, every worker slot ends up waiting
on it and healthy endpoints starve: one customer's outage becomes everyone's delay.

## Options considered

1. **Oldest-first claim** — simple, globally FIFO, but no isolation between endpoints.
2. **Round-robin across endpoints with a per-endpoint in-flight cap, in the claim query** — pick
   endpoints that have due work, give each only its free slots, lock rows per endpoint with a
   `LATERAL … FOR UPDATE SKIP LOCKED` subquery.
3. **Per-endpoint queues in Redis/a broker** — strong isolation, but a second source of truth
   (ADR 0001 rejected that).

## Decision

Option 2 (`packages/db/src/queue.ts: claimDue`). Endpoints with due work are taken in random
order (fair in expectation, no extra writes to track turns); each gets
`cap - in_flight` rows; degraded endpoints (5+ consecutive failures) get a cap of 1.

## Consequences

- A flooded or slow endpoint occupies at most `ENDPOINT_MAX_IN_FLIGHT` slots per claim cycle;
  `queue.int.test.ts` and `delivery.int.test.ts` check this.
- The cap is **soft**: two workers claiming at the same instant both read the same in-flight
  count and can briefly exceed it by up to (workers − 1) × free slots. Making it hard would need a
  per-endpoint lock or counter row, which adds a hot row per endpoint. Accepted for now.
- Global FIFO is gone: delivery order across endpoints is not creation order (it never was
  guaranteed — SPEC §3).
- Each claim scans endpoints with due work (bounded by `maxEndpoints`, default 200). With many
  thousands of busy endpoints this becomes the cost to watch.
