# Hookline — architecture

## 1. Components

```
 Producer app ──HTTP──▶ apps/api ──(one transaction)──▶ Postgres: messages + deliveries
                                                             │
                         apps/worker  ◀── claim (SKIP LOCKED) ┘
                             │   sign (Standard Webhooks), SSRF check, HTTP POST
                             ▼
                      Consumer endpoint  (apps/chaos-receiver in tests)
                             │
                 attempt row + delivery state update ──▶ Postgres

 apps/dashboard ──▶ apps/api (management endpoints, session auth, SSE live stream)
 apps/cli `listen` ══WebSocket══▶ apps/api relay ──▶ same claim/complete path as the worker
 Postgres LISTEN/NOTIFY ──▶ api EventHub ──▶ SSE clients; ──▶ workers (wake on new message)
 Redis: ingest + per-endpoint rate limits (in-memory fallback for a single process)
 OpenTelemetry from api + worker ──▶ Collector ──▶ Prometheus / Tempo / Loki ──▶ Grafana
```

- **api:** stateless; can run several replicas.
- **worker:** stateless; several replicas pull from the same queue safely. Each worker runs
  N concurrent delivery loops plus, on a leader-elected or advisory-locked schedule, the
  **reaper** and **retention** jobs.
- **Postgres** is the system of record _and_ the queue (see ADR 0001).

## 2. Data model (sketch — `packages/db/migrations/001_init.sql` is the exact schema)

```sql
apps        (id uuid pk, name text, created_at timestamptz)
api_keys    (id uuid pk, app_id fk, prefix text, key_hash bytea unique, created_at, revoked_at)
users       (id uuid pk, github_id bigint unique, login text, created_at)
memberships (user_id fk, app_id fk, role text check (role in ('owner','viewer')), pk(user_id, app_id))

endpoints (
  id uuid pk, app_id fk, url text, description text,
  event_types text[] null,            -- null = all
  rate_limit_per_sec int null,
  status text check (status in ('active','paused','disabled')), disabled_reason text,
  consecutive_failures int default 0, last_success_at timestamptz,
  created_at, updated_at
)
endpoint_secrets (
  id uuid pk, endpoint_id fk, secret_enc bytea, created_at, expires_at timestamptz null
)                                      -- >1 unexpired row during rotation

messages (
  id text pk,                          -- 'msg_' + ULID: sortable, used as webhook-id
  app_id fk, event_type text, payload json, payload_bytes int,
  idempotency_key text null, request_hash bytea null, created_at,
  unique (app_id, idempotency_key)
)

deliveries (
  id uuid pk, message_id fk, endpoint_id fk,
  status text check (status in ('pending','in_flight','succeeded','failed','cancelled')),
  attempt_count int default 0,
  next_attempt_at timestamptz,
  locked_by text null, locked_until timestamptz null,
  created_at, updated_at, completed_at null,
  unique (message_id, endpoint_id)
)
create index deliveries_due on deliveries (next_attempt_at) where status = 'pending';
create index deliveries_inflight on deliveries (locked_until) where status = 'in_flight';

attempts (
  id uuid pk, delivery_id fk, attempt_no int,
  started_at timestamptz, duration_ms int,
  response_status int null, response_snippet text null,     -- <= 4 KB
  error_kind text null, error_detail text null,
  unique (delivery_id, attempt_no)
)
```

## 3. The delivery pipeline

### Ingest (api)

1. Authenticate API key → `app_id`. Check rate limit (M6+). Validate body and size.
2. If `Idempotency-Key` present: look up `(app_id, key)`; same hash → return it; different → `409`.
3. In **one transaction**: insert message; insert one `pending` delivery (`next_attempt_at = now()`)
   per active endpoint whose `event_types` matches. Commit, return `202`.

### Claim (worker) — fair, see ADR 0005

```sql
WITH due_endpoints AS (          -- endpoints with due work, random order, with free slots
  SELECT e.id, cap(e) - (SELECT count(*) FROM deliveries f
                         WHERE f.endpoint_id = e.id AND f.status = 'in_flight') AS slots
  FROM endpoints e
  WHERE e.status = 'active' AND e.kind = 'http'
    AND EXISTS (SELECT 1 FROM deliveries p WHERE p.endpoint_id = e.id
                AND p.status = 'pending' AND p.next_attempt_at <= now())
  ORDER BY random() LIMIT 200
), picked AS (
  SELECT c.id FROM due_endpoints de
  CROSS JOIN LATERAL (SELECT d.id FROM deliveries d
                      WHERE d.endpoint_id = de.id AND d.status = 'pending' AND d.next_attempt_at <= now()
                      ORDER BY d.next_attempt_at LIMIT greatest(de.slots, 0)
                      FOR UPDATE SKIP LOCKED) c
  LIMIT $batch
)
UPDATE deliveries d SET status = 'in_flight', locked_by = $worker,
       locked_until = now() + make_interval(secs => $lease), updated_at = now()
FROM picked WHERE d.id = picked.id
RETURNING d.*;
```
`cap(e)` is `ENDPOINT_MAX_IN_FLIGHT`, or 1 once the endpoint has 5+ consecutive failures.
`SKIP LOCKED` lets many workers claim concurrently without blocking or double-claiming.
The lease must exceed the request timeout; `loadConfig` refuses a config where it doesn't.
Idle workers sleep with backoff but wake immediately on a `NOTIFY` for a new message.

### Send (worker)

1. Load message, endpoint and unexpired secrets. If the endpoint is paused or disabled, put the
   delivery back to `pending` (paused) or `cancelled` (disabled).
2. Resolve the host and run the SSRF check; pin the validated IP for the connection.
3. Sign and POST with the timeouts in SPEC §3. Read up to 4 KB of the body.
4. In one transaction: insert the attempt row; update the delivery:
   - success → `succeeded`, `completed_at`; endpoint `consecutive_failures = 0`, `last_success_at`
   - retryable failure and attempts in this cycle < 10 → `pending`, `next_attempt_at = now() + backoff(n)`
     (a manual retry or replay starts a new cycle by setting `retry_base = attempt_count`)
   - otherwise → `failed`; `410` → disable the endpoint and cancel its pending deliveries
   - always clear `locked_by` / `locked_until`
     The update is guarded with `WHERE id = $id AND locked_by = $worker` so a worker whose lease
     expired cannot overwrite a newer claim (its result is logged and dropped).

### Reaper (worker, every 10 s)

Moves `in_flight` rows whose `locked_until < now()` back to `pending`. This is what makes a
crashed worker safe, and it is also why duplicates are possible (at-least-once).

### Retention (worker, hourly)

Deletes payloads and attempts older than `RETENTION_DAYS` (default 30) in small batches.

## 4. Hard problems to solve deliberately

1. **Crash safety and duplicates:** lease + reaper + guarded update. Prove with a test that
   kills workers mid-run and checks every message reached the receiver ≥ 1 time.
2. **Noisy-neighbor fairness (implemented, ADR 0005):** a single endpoint with 1M pending deliveries
   or a slow endpoint must not starve others. Approaches to compare: per-endpoint in-flight cap
   enforced in the claim query; round-robin claiming across endpoints with due work;
   per-endpoint token buckets in Redis. Measure p95 time-to-first-attempt for a healthy endpoint
   while a sick one is flooded.
3. **SSRF and DNS rebinding:** validate the resolved IP and connect to that IP.
4. **Circuit breaking (Stage 3):** after 5 consecutive failures an endpoint drops to 1
   concurrent request; if it has had no success for 5 days, disable it with reason
   `failing` and emit a `hookline.endpoint.disabled` event.
5. **Queue table health:** high-churn tables bloat; watch autovacuum, keep indexes partial,
   and batch retention deletes.
6. **Optional FIFO mode (Stage 3):** at most one in-flight delivery per endpoint, in message
   order; a failing message blocks later ones. Document the trade-off.

## 5. Observability

- Traces: span for ingest; the trace context is stored on the message so the worker's
  `deliver` span links to it; child span for the HTTP request.
- Metrics: `hookline_messages_ingested_total`, `hookline_attempts_total{outcome,error_kind}`,
  `hookline_delivery_latency_seconds` (ingest → first attempt), `hookline_attempt_duration_seconds`,
  `hookline_queue_depth{status}`, `hookline_reaped_total`.
- Logs: pino JSON with `app_id`, `message_id`, `delivery_id`, `endpoint_id`, `trace_id`.
- One Grafana dashboard shipped in `deploy/grafana/`.

## 6. Configuration (env, validated by Zod)

`DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` (32-byte base64), `ALLOW_INSECURE_ENDPOINTS`,
`ENDPOINT_ALLOWLIST`, `WORKER_CONCURRENCY`, `CLAIM_BATCH_SIZE`, `LEASE_SECONDS`,
`RETENTION_DAYS`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`,
`OTEL_EXPORTER_OTLP_ENDPOINT`.

## 7. Deployment

- Local: `deploy/docker-compose.yml` (Postgres, Redis, observability stack, chaos-receiver).
- Demo: one small VM or a PaaS: api ×2, worker ×2, dashboard, managed Postgres and Redis.
- CI: lint → typecheck → unit → integration (Testcontainers) → build images → deploy on `main`.

## 8. Implementation notes (as built)

- Retry policy is one pure function (`packages/core/src/retry.ts: decide`), shared by the HTTP
  worker and the CLI relay via `decideForDelivery`.
- `completeAttempt` (`packages/db/src/queue.ts`) writes the attempt row, the delivery's next state,
  the endpoint's breaker counters and a `pg_notify` in one transaction.
- SSRF protection runs inside the socket's DNS lookup (`apps/worker/src/transport.ts`), so the
  address that passed the check is the one connected to; IP-literal hosts are checked directly.
- Periodic jobs (reaper, breaker, retention, queue-depth gauge) are idempotent and run on every
  worker; no leader election.
- The worker never follows redirects, reads at most 4 KB of a response, and sends a
  `traceparent` header continuing its delivery span (linked to the ingest trace).
- Payloads are stored as `json` (ADR 0008); `deliveries.retry_base` marks the start of the
  current retry cycle.
