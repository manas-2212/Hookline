# ADR 0001: Use Postgres as the delivery queue

**Status:** accepted

## Context

Deliveries need durable state (status, attempts, next retry time) that the dashboard queries,
and they must be created atomically with the message. A separate broker (Kafka, RabbitMQ, SQS)
would add a second source of truth and a dual-write problem between it and the database.

## Decision

Store deliveries in Postgres and have workers claim due rows with
`SELECT … FOR UPDATE SKIP LOCKED` inside an `UPDATE … RETURNING`, using a lease
(`locked_until`) and a reaper for crash recovery.

## Consequences

- Fan-out is a single transaction; no outbox needed between DB and queue.
- Retry scheduling is just `next_attempt_at`; the dashboard reads the same rows.
- Throughput is bounded by Postgres write capacity; high-churn tables need vacuum attention.
  Measure the ceiling in M9 and document when a broker would become worth it.
