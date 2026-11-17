import type { ColumnType, Generated, Insertable, Selectable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type DeliveryStatus = "pending" | "in_flight" | "succeeded" | "failed" | "cancelled";
export type EndpointStatus = "active" | "paused" | "disabled";
export type EndpointKind = "http" | "relay";
export type Role = "owner" | "viewer";

export interface AppsTable {
  id: Generated<string>;
  name: string;
  created_at: Timestamp;
}

export interface ApiKeysTable {
  id: Generated<string>;
  app_id: string;
  prefix: string;
  key_hash: Buffer;
  label: string | null;
  created_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface UsersTable {
  id: Generated<string>;
  github_id: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  login: string;
  avatar_url: string | null;
  created_at: Timestamp;
}

export interface MembershipsTable {
  user_id: string;
  app_id: string;
  role: Role;
}

export interface EndpointsTable {
  id: Generated<string>;
  app_id: string;
  kind: ColumnType<EndpointKind, EndpointKind | undefined, EndpointKind>;
  url: string | null;
  description: string | null;
  event_types: string[] | null;
  rate_limit_per_sec: number | null;
  status: ColumnType<EndpointStatus, EndpointStatus | undefined, EndpointStatus>;
  disabled_reason: string | null;
  consecutive_failures: Generated<number>;
  last_success_at: NullableTimestamp;
  last_failure_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EndpointSecretsTable {
  id: Generated<string>;
  endpoint_id: string;
  secret_enc: Buffer;
  created_at: Timestamp;
  expires_at: NullableTimestamp;
}

export interface MessagesTable {
  id: string;
  app_id: string;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  payload_bytes: number;
  idempotency_key: string | null;
  request_hash: Buffer | null;
  trace_parent: string | null;
  created_at: Timestamp;
}

export interface DeliveriesTable {
  id: Generated<string>;
  message_id: string;
  endpoint_id: string;
  app_id: string;
  status: ColumnType<DeliveryStatus, DeliveryStatus | undefined, DeliveryStatus>;
  attempt_count: Generated<number>;
  retry_base: Generated<number>;
  next_attempt_at: Timestamp;
  locked_by: string | null;
  locked_until: NullableTimestamp;
  first_attempt_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttemptsTable {
  id: Generated<string>;
  delivery_id: string;
  app_id: string;
  endpoint_id: string;
  attempt_no: number;
  transport: ColumnType<string, string | undefined, string>;
  started_at: Timestamp;
  duration_ms: number;
  response_status: number | null;
  response_snippet: string | null;
  error_kind: string | null;
  error_detail: string | null;
}

export interface Database {
  apps: AppsTable;
  api_keys: ApiKeysTable;
  users: UsersTable;
  memberships: MembershipsTable;
  endpoints: EndpointsTable;
  endpoint_secrets: EndpointSecretsTable;
  messages: MessagesTable;
  deliveries: DeliveriesTable;
  attempts: AttemptsTable;
}

export type App = Selectable<AppsTable>;
export type Endpoint = Selectable<EndpointsTable>;
export type Message = Selectable<MessagesTable>;
export type Delivery = Selectable<DeliveriesTable>;
export type Attempt = Selectable<AttemptsTable>;
export type User = Selectable<UsersTable>;
export type NewEndpoint = Insertable<EndpointsTable>;
