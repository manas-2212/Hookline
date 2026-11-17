# Architecture decision records

| ADR                                        | Decision                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| [0001](0001-postgres-as-queue.md)          | Postgres is the delivery queue (`SKIP LOCKED` + leases), no separate broker |
| [0002](0002-standard-webhooks-signing.md)  | Sign deliveries using Standard Webhooks                                     |
| [0003](0003-typescript-monorepo.md)        | TypeScript everywhere, pnpm monorepo                                        |
| [0004](0004-dashboard-vite-spa.md)         | Dashboard is a Vite SPA served by the API (not Next.js)                     |
| [0005](0005-fair-claiming.md)              | Fair claiming with per-endpoint in-flight caps                              |
| [0006](0006-cli-relay-transport.md)        | Relay transport so `hookline listen` can receive on localhost               |
| [0007](0007-integration-test-databases.md) | Integration tests create a database per file (not Testcontainers)           |
| [0008](0008-payload-as-json.md)            | Store payloads as `json`, not `jsonb`                                       |
