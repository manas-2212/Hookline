import { monotonicFactory } from "ulid";

export * from "./crypto.js";
export * from "./delivery.js";
export * from "./health.js";
export * from "./net.js";
export * from "./retry.js";
export * from "./signing.js";
export * from "./trace.js";

const ulid = monotonicFactory();

/** Message ids are sortable and double as the Standard Webhooks `webhook-id`. */
export const newMessageId = (): string => `msg_${ulid()}`;

export const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const RESPONSE_SNIPPET_BYTES = 4 * 1024;
