# Hookline — roadmap

Work one milestone at a time. A milestone is done only when every acceptance criterion has a
passing test (or a documented manual check where noted), CI is green, and the owner has
reviewed and committed it.

## Status (as built)

| Milestone                           | State                                                                                                         | Where to look                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0 Scaffold                         | done                                                                                                          | root `package.json`, `biome.json`, `vitest.config.ts`, `.github/workflows/ci.yml`                        |
| M1 Data model, apps, API keys       | done                                                                                                          | `packages/db/migrations/001_init.sql`, `packages/db/src/tenants.ts`, `apps/api/src/auth.ts`              |
| M2 Endpoints                        | done                                                                                                          | `apps/api/src/routes/endpoints.ts`, `packages/db/src/endpoints.ts`                                       |
| M3 Ingest and fan-out               | done                                                                                                          | `packages/db/src/messages.ts` (atomic fan-out, idempotency incl. concurrent races)                       |
| M4 Worker and signing               | done                                                                                                          | `apps/worker/src/worker.ts`, `packages/core/src/signing.ts` (passes the Standard Webhooks test vector)   |
| M5 Retries, reaper, terminal states | done                                                                                                          | `packages/core/src/retry.ts`, `packages/db/src/queue.ts`, `scripts/torture.ts` (SIGKILL test)            |
| M6 Security and limits              | done                                                                                                          | `packages/core/src/net.ts`, `apps/worker/src/transport.ts` (DNS-pinned SSRF guard), `packages/ratelimit` |
| M7 Dashboard                        | done, as a Vite SPA (ADR 0004)                                                                                | `apps/dashboard`                                                                                         |
| M8 Observability                    | done                                                                                                          | `packages/telemetry`, `apps/*/src/metrics.ts`, `deploy/` (Prometheus, Tempo, Grafana dashboard)          |
| M9 Reliability suite, load tests    | torture suite done and recorded; k6 script written but **not yet run**                                        | `scripts/torture.ts`, `loadtests/`, `docs/MEASUREMENTS.md`                                               |
| M10 Noisy-neighbor fairness         | done: per-endpoint caps in the claim (ADR 0005); only one strategy implemented, not two compared              | `packages/db/src/queue.ts: claimDue`                                                                     |
| M11 Circuit breaker                 | done                                                                                                          | `packages/core/src/health.ts`, `disableLongFailing`, degraded cap in `claimDue`                          |
| M12 Developer experience            | SDK and CLI done, incl. `hookline listen` relay (ADR 0006); FIFO mode **not built**; SDK not published to npm | `packages/sdk`, `apps/cli`                                                                               |
| M13 Consumer portal                 | **not built**                                                                                                 | —                                                                                                        |

Deviations from this plan are recorded as ADRs 0004–0008.

---

## Stage 1 — Strong MVP

### M0 · Scaffold

- pnpm monorepo with the layout in the README; strict tsconfig; Biome; Vitest.
- `packages/config` env parsing with Zod; `apps/api` with `/healthz` and `/readyz`.
- `deploy/docker-compose.yml` with Postgres 16 (Redis and observability come later).
- GitHub Actions: install, lint, typecheck, test.

**Accept:** `pnpm dev` starts the API; `/readyz` returns 200 only when Postgres is up; CI green.

### M1 · Data model, apps and API keys

- Kysely setup, migrator, initial migration for every table in ARCHITECTURE §2.
- `pnpm db:seed` creates an app and an API key (printed once).
- API-key auth hook: hashed lookup, revoked keys rejected, `app_id` on the request.

**Accept:** an unknown, malformed or revoked key gets 401; a valid key reaches a protected test
route; keys are never stored in plaintext (test inspects the row).

### M2 · Endpoints

- CRUD, pause/resume, event-type filters, `rate_limit_per_sec` stored (enforced in M6).
- Secret generation (`whsec_`), AES-256-GCM encryption at rest; returned only on create.
- URL validation at create time (scheme, length; SSRF check comes in M6).
- RFC 9457 error responses; cursor pagination helper.

**Accept:** tenant isolation test (app A cannot read, update or delete app B's endpoint → 404);
secret round-trips encrypt/decrypt; DB row contains no plaintext secret.

### M3 · Message ingest and fan-out

- `POST /v1/messages` with size limit, idempotency (SPEC §3), atomic fan-out.
- `GET` message and delivery endpoints.

**Accept:** fan-out creates one delivery per matching active endpoint and none for paused or
non-matching ones; same idempotency key + same body → same id; different body → 409; a
forced failure after the message insert leaves neither message nor deliveries.

### M4 · Worker and signing

- `packages/core`: Standard Webhooks signing and verification, with test vectors.
- Worker: claim query, concurrent loops, HTTP sender with timeouts and no redirects,
  attempt recording, success path.
- `apps/chaos-receiver`: records every received `webhook-id`, verifies signatures, and can be
  configured per path to return codes, add latency, time out or reset connections.
- `packages/sdk`: `verify()` helper used by the chaos receiver.

**Accept:** end-to-end test: publish 100 messages → all reach the receiver with valid
signatures; two workers in parallel never send the same delivery twice in the happy path
(no crash).

### M5 · Retries, reaper and terminal states

- Retry schedule with ±20% jitter via injected clock/RNG; `Retry-After`; `410` handling.
- Lease + reaper; guarded state updates (`locked_by`).
- `POST /v1/deliveries/:id/retry`.
- Deploy the API, worker and receiver somewhere public (even a single VM).

**Accept:** unit tests for the schedule (bounds with jitter); receiver failing first k times →
delivered on attempt k+1; always failing → `failed` after 10 attempts (using a fast fake
clock); **crash test:** kill a worker process mid-batch → after the reaper runs every message is
delivered at least once; duplicates are counted and reported. 410 disables the endpoint.

---

## Stage 2 — Production-grade

### M6 · Security and limits

- SSRF protection with DNS pinning and allowlist override (SPEC §5).
- Redis token buckets: ingest per app; delivery per endpoint (`rate_limit_per_sec`).
- Secret rotation with dual signatures for 24 h.
- OpenAPI generated from Zod and served at `/openapi.json`.

**Accept:** table-driven tests for blocked ranges (v4 and v6, incl. 169.254.169.254, `::1`,
`::ffff:127.0.0.1`); a hostname that resolves to a private IP is blocked at send time; rotation
test verifies both signatures validate during the window and only the new one after.

### M7 · Dashboard

- GitHub OAuth, sessions, memberships and roles.
- Endpoints page, message log, message detail with attempts, retry and replay actions,
  test event button, overview page.

**Accept:** viewer cannot mutate (API returns 403, UI hides actions); Playwright smoke test of
login → create endpoint → send test event → see attempt.

### M8 · Observability

- OpenTelemetry traces linking ingest to delivery; metrics from ARCHITECTURE §5; pino logs.
- Add Prometheus, Tempo, Loki, Grafana, OTel Collector to compose; ship one dashboard.

**Accept:** a single trace shows ingest → deliver → HTTP POST; the dashboard shows queue depth
and success rate during a test run (manual check, screenshot in `docs/`).

### M9 · Reliability suite, load tests, deployment

- k6 scripts: steady ingest; burst; mixed receiver behavior (slow, failing, healthy).
- A reliability script that runs a scenario, kills workers randomly, then checks for loss and
  counts duplicates.
- Record results in `docs/MEASUREMENTS.md`. CI builds images and deploys on `main`.

**Accept:** zero lost messages across recorded runs; results table filled with real numbers,
date and hardware.

---

## Stage 3 — Standout

### M10 · Noisy-neighbor fairness

Implement and compare at least two strategies from ARCHITECTURE §4.2; write an ADR with the
measurements.
**Accept:** with one endpoint flooded and slow, a healthy endpoint's p95 time-to-first-attempt
stays within a target you set and record before and after.

### M11 · Circuit breaker and endpoint health

Degrade to 1 concurrent request after 5 consecutive failures; auto-disable after 5 days without
success; `hookline.endpoint.disabled` event; health scores in the dashboard.

### M12 · Developer experience

Published TypeScript SDK (client + verify), example receiver apps (Express, Next.js route),
quickstart in README, optional FIFO mode per endpoint.

### M13 (optional) · Consumer portal

An embeddable page the producer can give its customers to manage their own endpoints and see
their delivery logs, using short-lived signed tokens.
