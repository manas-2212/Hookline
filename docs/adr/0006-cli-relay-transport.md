# ADR 0006: A relay transport so developers can receive webhooks on localhost

**Status:** accepted

## Context

Testing webhook consumers locally usually means a tunnel (ngrok and similar): a public URL that
forwards to a laptop. That is an extra tool, an extra account, and an exposed port.

## Decision

Add an endpoint kind `relay`. `hookline listen --forward-to http://localhost:3000/webhooks`
creates a relay endpoint and opens a WebSocket to the API (`/v1/relay/:endpointId`, API-key
authenticated). The API claims that endpoint's deliveries with the **same** `claimDue` query,
lease, signing, retry policy and attempt log as the HTTP worker, pushes each down the socket, and
records the result the CLI reports back.

## Consequences

- Only the transport differs between HTTP and relay; `decideForDelivery` and `completeAttempt`
  are shared, so retries and the dashboard behave identically.
- When the socket closes, unanswered deliveries are released immediately (no attempt counted);
  if the API process dies instead, the reaper recovers them when the lease expires.
- Relay endpoints are never claimed by HTTP workers (`kind` filter in `claimDue`).
- A relay session is pinned to one API replica; that's fine because claims are per endpoint and
  any replica can serve the socket.
