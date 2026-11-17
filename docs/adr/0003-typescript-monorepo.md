# ADR 0003: TypeScript everywhere, in a pnpm monorepo

**Status:** accepted

## Context

The project has an API, workers, a dashboard and an SDK. It is built by one person and is meant
to show full-stack depth. TypeScript appears in a large share of full-stack postings, and
sharing types between API, SDK and dashboard removes a class of contract bugs.

## Decision

Use TypeScript (strict) on Node.js 22 for every app and package, organized as a pnpm workspace
monorepo. Fastify + Zod for the API, Kysely for SQL, Next.js for the dashboard.

## Consequences

- One toolchain, shared Zod schemas, generated OpenAPI.
- Node's single-threaded event loop suits I/O-bound delivery work; CPU-heavy work (signing is
  cheap) is not expected. If the worker becomes CPU-bound, revisit (e.g., a Go worker).
