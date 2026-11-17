# Study guide: owning this codebase

This project was generated end to end, so its value on a resume depends on you being able to
explain and change it. Work through this list in order. For each item: read the code named, answer
the questions out loud without looking, then make the suggested change yourself and run the tests.

## 1. The delivery contract (start here)

Read `docs/SPEC.md` §3, then `packages/core/src/retry.ts`.

- Why is delivery _at-least-once_ and not exactly-once? Describe the exact sequence of events that
  produces a duplicate. (Hint: worker sends, receiver answers 200, worker dies before
  `completeAttempt` commits.)
- How should a receiver deduplicate? Which header does it use and why is that stable across retries?
- Why is 410 treated differently from 404? Why is an SSRF block never retried?
- **Change it:** make 404 also disable the endpoint after 3 consecutive 404s. Write the test first.

## 2. Postgres as a queue

Read `packages/db/src/queue.ts` top to bottom, and ADR 0001.

- What does `FOR UPDATE SKIP LOCKED` do, and what would happen without `SKIP LOCKED`?
- What is the lease (`locked_until`) for? What breaks if the lease is shorter than the HTTP timeout?
  (Find where `loadConfig` refuses that configuration.)
- In `completeAttempt`, why is the UPDATE guarded by `locked_by = $worker`? Walk through the test
  "ignores a completion from a worker that lost its lease".
- Why is the attempt row, the delivery update, the endpoint counter update and `pg_notify` all in
  one transaction?
- **Change it:** add a `max_attempts` column per endpoint that overrides the global 10.

## 3. Fair claiming (your best interview story)

Read `claimDue` and ADR 0005.

- Draw what goes wrong with "claim the 64 oldest due rows" when one endpoint has 100k pending
  deliveries and responds in 2 seconds.
- Explain the `LATERAL` subquery and why the lock is taken per endpoint.
- Why is the cap "soft"? Construct the race. How would you make it hard, and what would it cost?
- **Measure it:** run `scripts/torture.ts` and compare the healthy endpoint's time-to-first-attempt
  with `ENDPOINT_MAX_IN_FLIGHT=1000` (effectively no cap) versus the default.

## 4. Crash safety, proven

Read `scripts/torture.ts` and the results in `docs/MEASUREMENTS.md`.

- How does the script decide a delivery was _lost_ versus _failed_? Could it miss a loss?
- Why are duplicates expected after SIGKILL but losses are not?
- **Change it:** add a scenario that restarts Postgres mid-run. What do you expect to happen? Then run it.

## 5. Signing and secrets

Read `packages/core/src/signing.ts`, `packages/db/src/endpoints.ts: rotateSecret`, `crypto.ts`.

- Why sign `id.timestamp.body` and not just the body? What attack does the timestamp tolerance stop?
- Why `timingSafeEqual`? Why is the API-key lookup by hash immune to timing attacks without it?
- How does rotation avoid dropping requests? What does the receiver see during the 24 h window?
- Why AES-GCM for secrets at rest, and what does the auth tag protect against?

## 6. SSRF

Read `packages/core/src/net.ts` and `apps/worker/src/transport.ts`.

- What is SSRF and why is a webhook sender a perfect SSRF tool if unprotected?
- What is DNS rebinding, and why does checking the URL at endpoint-creation time not stop it?
- Why are `::ffff:127.0.0.1` and `64:ff9b::7f00:1` in the block list?
- Why are redirects not followed?

## 7. The API layer

Read `apps/api/src/auth.ts`, `routes/messages.ts`, `packages/db/src/messages.ts`.

- How does idempotency survive two identical requests arriving at the same millisecond?
  (Find the `23505` handling.)
- Why does fan-out happen inside the ingest transaction instead of in the worker?
- How does the dashboard avoid CSRF without tokens? Why does `SameSite=Lax` alone not suffice for
  every case?
- Why does `/v1/live` accept the app id in the query string, and why is that acceptable there only?

## 8. Real-time

Read `packages/db/src/client.ts: listenEvents`, `apps/api/src/hub.ts`, `routes/live.ts`, `routes/relay.ts`.

- Why one LISTEN connection per process rather than per SSE client?
- What happens to the live stream with three API replicas? With a worker on another machine?
- How does `hookline listen` reuse the queue? What happens to in-flight deliveries when the laptop
  sleeps?

## 9. Things to say honestly in an interview

- Which numbers you measured, on what machine, and what you'd expect on real hardware.
- The soft cap, the lack of FIFO mode, and that the k6 load test hasn't been run yet.
- What you'd change first for production: connection pooling (PgBouncer), partitioning
  `attempts` by time, moving periodic jobs behind an advisory lock, publishing the SDK.
