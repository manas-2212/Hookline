# One image for every Hookline process; the compose `command` picks which one runs.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && pnpm --filter @hookline/dashboard build
ENV NODE_ENV=production
USER node
