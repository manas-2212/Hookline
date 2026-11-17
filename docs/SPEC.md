# Hookline — product specification

## 1. Problem

Every SaaS product that sends webhooks ends up rebuilding the same fragile machinery: retries,
signatures, timeouts, a way for customers to debug failed deliveries, and protection against
one broken customer endpoint slowing everyone down. Hookline is that machinery as a
self-hostable service.

**Producer:** an application that calls Hookline's API to publish events.
**Consumer:** the producer's customer, who owns an HTTPS endpoint that receives events.

## 2. Core concepts

| Concept  | Meaning                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App      | A tenant. One producer application. Owns API keys, endpoints, messages.                                                                                                      |
| API key  | Secret bearer token for an app. Stored hashed; shown once at creation.                                                                                                       |
| Endpoint | A consumer URL plus its signing secret, event-type filter, rate limit and status. Kind `http` (a URL) or `relay` (delivered to a connected `hookline listen` CLI, ADR 0006). |
| Message  | One event published by the producer: `event_type`, JSON `payload`, optional idempotency key. Immutable.                                                                      |
| Delivery | The job of getting one message to one endpoint. A message fans out to one delivery per matching endpoint.                                                                    |
| Attempt  | One HTTP request made for a delivery, with its outcome.                                                                                                                      |
| User     | A dashboard login. Belongs to apps via memberships with role `owner` or `viewer`.                                                                                            |

## 3. Delivery semantics (the contract)

- **At-least-once.** A message accepted with `202` will be delivered to every matching active
  endpoint at least once, or end in a visible terminal `failed` state. Duplicates are possible
  (e.g., worker crash after the consumer responded); consumers dedupe on the `webhook-id` header.
- **No loss on crash.** Killing any worker process at any moment must not lose a delivery.
- **Ordering:** not guaranteed by default. (Optional per-endpoint FIFO mode in Stage 3.)
- **Payload bytes are preserved:** the body delivered is exactly the JSON text the API received
  (stored as `json`, not `jsonb` — ADR 0008).
- **Fan-out is atomic with ingest:** the message row and its delivery rows are written in one
  transaction. If ingest returns `202`, the deliveries exist.
- **Idempotent ingest:** a repeated `Idempotency-Key` for the same app within 24 h returns the
  original message (`200`) instead of creating a new one. Same key with a different body → `409`.
- **Success:** any `2xx` response within the timeout.
- **Retry:** any other outcome (timeout, DNS/connect/TLS error, non-2xx) is retried, except:
  - `410 Gone` → endpoint is set to `disabled` (reason `gone`); pending deliveries cancelled.
  - SSRF-blocked destination → delivery fails immediately, no retry.
- **Retry schedule** (delay after attempt n, with ±20% jitter): 5 s, 30 s, 2 m, 10 m, 30 m,
  1 h, 3 h, 6 h, 12 h. That is 10 attempts in total over roughly 23 h; after the 10th failure,
  the delivery is `failed`.
- **`Retry-After`:** on `429` or `503`, honor `Retry-After` if it is longer than the scheduled
  delay (cap 12 h).
- **Timeouts:** connect 5 s, total 15 s. Redirects are **not** followed (treated as failure).
  At most 4 KB of the response body is stored.

## 4. Signing (Standard Webhooks)

Hookline follows the Standard Webhooks convention so existing verification libraries work.

- Headers: `webhook-id` (the message id), `webhook-timestamp` (unix seconds),
  `webhook-signature` (`v1,<base64 HMAC-SHA256>`; space-separated if several).
- Signed content: `${webhook-id}.${webhook-timestamp}.${raw body}`.
- Secrets: 32 random bytes, presented as `whsec_<base64>`; encrypted at rest (AES-256-GCM,
  key from env).
- **Rotation:** rotating creates a new secret; the old one stays valid for 24 h and both
  signatures are sent during that window.
- The SDK provides `verify(headers, rawBody, secret, toleranceSeconds = 300)`.

## 5. Security requirements

- **SSRF protection:** endpoint URLs must be `https` (plain `http` allowed only when
  `ALLOW_INSECURE_ENDPOINTS=true`, for local dev). At send time, resolve DNS and refuse
  loopback, private (RFC 1918), link-local (incl. 169.254.169.254), CGNAT (100.64.0.0/10),
  multicast, unspecified, and IPv6 equivalents (::1, fc00::/7, fe80::/10). Connect to the
  validated IP (pin it) so DNS rebinding can't swap the target. `ENDPOINT_ALLOWLIST` (CIDRs)
  can override for testing with the chaos receiver.
- API keys: format `hk_<random>`; store a SHA-256 hash and a short prefix for display.
- Tenant isolation: every query is scoped by `app_id`; cross-tenant access returns `404`.
- Ingest rate limit per app (token bucket in Redis), `429` with `Retry-After`.
- Payload size limit: 256 KB. Header and URL length limits enforced.

## 6. HTTP API (v1)

Auth: `Authorization: Bearer hk_...`. JSON bodies. Errors use RFC 9457 `application/problem+json`.
Lists use cursor pagination (`?limit=&cursor=`), newest first.

| Method & path                                                                | Purpose                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/messages`                                                          | Publish `{event_type, payload}`; optional `Idempotency-Key` header → `202 {id}`                                        |
| `GET /v1/messages`                                                           | List, filter by `event_type`, time range                                                                               |
| `GET /v1/messages/:id`                                                       | Message with per-endpoint delivery status                                                                              |
| `GET /v1/messages/:id/deliveries`                                            | Deliveries for a message                                                                                               |
| `GET /v1/deliveries/:id/attempts`                                            | Attempts for a delivery                                                                                                |
| `POST /v1/deliveries/:id/retry`                                              | Re-queue a failed delivery now                                                                                         |
| `POST /v1/endpoints`                                                         | Create `{url, description?, event_types?, rate_limit_per_sec?}` → returns secret once                                  |
| `GET /v1/endpoints`, `GET/PATCH/DELETE /v1/endpoints/:id`                    | Manage endpoints (`PATCH` can pause/resume)                                                                            |
| `POST /v1/endpoints/:id/rotate-secret`                                       | Rotate signing secret                                                                                                  |
| `POST /v1/endpoints/:id/test`                                                | Send a `hookline.test` event                                                                                           |
| `POST /v1/endpoints/:id/replay`                                              | Re-deliver messages in `{since, until?, only_failed?}`; also back-fills messages published before the endpoint existed |
| `GET /v1/live`                                                               | Server-Sent Events: messages arriving, attempts finishing, endpoints disabled                                          |
| `GET /v1/attempts/recent`                                                    | Attempts in the last N seconds (seeds the dashboard's live wire)                                                       |
| `GET /v1/stats/overview`                                                     | Queue counts, per-minute attempts, time-to-first-attempt percentiles                                                   |
| `GET/POST /v1/api-keys`, `DELETE /v1/api-keys/:id`                           | Manage API keys (owner)                                                                                                |
| `GET /v1/relay/:endpointId` (WebSocket)                                      | Relay transport used by `hookline listen`                                                                              |
| `GET /v1/me`, `POST /v1/apps`, `POST /v1/auth/dev-login`, `GET /auth/github` | Dashboard session and apps                                                                                             |
| `GET /healthz`, `GET /readyz`                                                | Liveness / readiness (DB reachable)                                                                                    |

OpenAPI 3.1 is generated from the Zod schemas and served at `/openapi.json`.

## 7. Dashboard

- GitHub OAuth login (plus a no-password dev login when `DEV_LOGIN=true`, refused in
  production); app switcher; role checks (`viewer` is read-only). Cookie-authenticated requests
  must carry a custom header (`x-hookline-app` / `x-hookline-csrf`), which blocks cross-site form
  posts.
- **Live wire:** one lane per endpoint, every attempt drawn as it happens (SSE).
- **Endpoints:** list with health (success rate over 24 h, last error), create, pause, rotate
  secret, send test event.
- **Message log:** searchable list; message detail shows each endpoint's delivery and every
  attempt (status code, duration, error kind, response snippet, request headers sent).
- **Actions:** retry a delivery; replay a time range to an endpoint.
- **Overview:** a written summary (delivered, given up, waiting, time-to-first-attempt
  p50/p95), attempts per minute, endpoints needing attention.

## 8. Non-goals

Inbound webhook ingestion, transformations or scripting on payloads, multi-region
replication, and billing. Out of scope; say so in the README.

## 9. Glossary of statuses

- Endpoint: `active` · `paused` (by user) · `disabled` (by system, with `disabled_reason`)
- Delivery: `pending` · `in_flight` · `succeeded` · `failed` · `cancelled`
- Attempt error kinds: `timeout` · `dns` · `connect` · `tls` · `http_status` · `redirect` ·
  `ssrf_blocked` · `body_too_large`
