# ADR 0007: Integration tests create a database per file on a running Postgres

**Status:** accepted (replaces "Testcontainers" in the original stack)

## Context

Integration tests must hit real Postgres, never mocks. Testcontainers needs a Docker daemon
inside the test process, which is not available in every environment (some CI runners, cloud
dev sandboxes), and starting a container per suite is slow.

## Decision

Tests connect to the server in `DATABASE_URL` and call `createTestDatabase()`
(`packages/db/src/testing.ts`), which creates a uniquely named database, runs all migrations,
and drops it afterwards. Locally the server comes from `docker compose`; in CI from a GitHub
Actions service container.

## Consequences

- Still no DB mocks; each test file is isolated, so files run in parallel.
- Tests need a Postgres server reachable before they start (`pnpm test:int` fails fast if not).
- The migrator itself is exercised on every test run.
