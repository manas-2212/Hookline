-- Hookline initial schema. Forward-only: never edit after it has been applied.

CREATE TABLE apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  prefix      text NOT NULL,
  key_hash    bytea NOT NULL UNIQUE,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   bigint UNIQUE,
  login       text NOT NULL UNIQUE,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'viewer')),
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE endpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- 'http': delivered by workers. 'relay': delivered to a connected `hookline listen` CLI.
  kind                  text NOT NULL DEFAULT 'http' CHECK (kind IN ('http', 'relay')),
  url                   text,
  description           text,
  event_types           text[],          -- NULL = all event types
  rate_limit_per_sec    integer CHECK (rate_limit_per_sec > 0),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  disabled_reason       text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'http') = (url IS NOT NULL))
);
CREATE INDEX endpoints_app ON endpoints (app_id, created_at DESC);

CREATE TABLE endpoint_secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id  uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  secret_enc   bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz            -- set on the old secret during rotation
);
CREATE INDEX endpoint_secrets_endpoint ON endpoint_secrets (endpoint_id);

CREATE TABLE messages (
  id               text PRIMARY KEY,   -- 'msg_' + ULID; also the webhook-id header
  app_id           uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event_type       text NOT NULL,
  payload          json NOT NULL,      -- json, not jsonb: keeps the producer's exact text and key order
  payload_bytes    integer NOT NULL,
  idempotency_key  text,
  request_hash     bytea,
  trace_parent     text,               -- W3C traceparent of the ingest span, links worker spans
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_idempotency ON messages (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_app_created ON messages (app_id, created_at DESC, id DESC);
CREATE INDEX messages_app_type ON messages (app_id, event_type, created_at DESC);

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  app_id           uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'cancelled')),
  attempt_count    integer NOT NULL DEFAULT 0,
  -- attempt_count at the start of the current retry cycle; manual retry/replay starts a new
  -- cycle so the backoff schedule restarts while attempt numbers keep increasing.
  retry_base       integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_by        text,
  locked_until     timestamptz,
  first_attempt_at timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, endpoint_id)
);
-- The queue: partial indexes stay small because finished rows drop out of them.
CREATE INDEX deliveries_due ON deliveries (endpoint_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_inflight ON deliveries (endpoint_id, locked_until) WHERE status = 'in_flight';
CREATE INDEX deliveries_endpoint_created ON deliveries (endpoint_id, created_at DESC);
CREATE INDEX deliveries_app_status ON deliveries (app_id, status);

CREATE TABLE attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id       uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  app_id            uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  endpoint_id       uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  attempt_no        integer NOT NULL,
  transport         text NOT NULL DEFAULT 'http',
  started_at        timestamptz NOT NULL,
  duration_ms       integer NOT NULL,
  response_status   integer,
  response_snippet  text,
  error_kind        text,
  error_detail      text,
  UNIQUE (delivery_id, attempt_no)
);
CREATE INDEX attempts_endpoint_started ON attempts (endpoint_id, started_at DESC);
CREATE INDEX attempts_app_started ON attempts (app_id, started_at DESC);
