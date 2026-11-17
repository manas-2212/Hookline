# ADR 0004: Dashboard is a Vite + React SPA served by the API, not Next.js

**Status:** accepted (supersedes the Next.js line in ADR 0003)

## Context

The dashboard is an authenticated admin console: every view needs the session and live data,
nothing benefits from server rendering or SEO, and the deployable unit should stay small for a
self-hosted product.

## Options considered

1. **Next.js (App Router)** — familiar to recruiters; but adds a second Node server, a second
   origin (CORS + cross-site cookies, or a proxy), and server-component complexity we don't use.
2. **Vite + React SPA, built to static files and served by the Fastify API** — one origin, so the
   session cookie is first-party and `SameSite=Lax`; one process to deploy; fast builds.

## Decision

Option 2. TanStack Query for server state, React Router for routes, no UI kit; fonts are bundled
locally (no third-party requests from a self-hosted install).

## Consequences

- `apps/api` serves `apps/dashboard/dist` with an SPA fallback; missing asset files still 404.
- In development, Vite proxies `/v1` and `/auth` to the API.
- If marketing pages or SSR are ever needed, they belong in a separate site, not this console.
