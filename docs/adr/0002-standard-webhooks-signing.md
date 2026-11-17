# ADR 0002: Sign deliveries using the Standard Webhooks convention

**Status:** accepted

## Context

Consumers need to verify that a request came from the producer and wasn't replayed. A custom
scheme forces every consumer to write bespoke verification code.

## Decision

Follow the Standard Webhooks convention: `webhook-id`, `webhook-timestamp` and
`webhook-signature` headers; HMAC-SHA256 over `id.timestamp.body`; `v1,` prefixed base64
signatures, space-separated when several secrets are active; `whsec_` secrets.

## Consequences

- Existing verification libraries work for consumers; our SDK still ships a `verify()` helper.
- `webhook-id` doubles as the consumer's deduplication key, which matches our at-least-once
  contract.
- Rotation is simple: sign with every unexpired secret during the overlap window.
