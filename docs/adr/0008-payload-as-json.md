# ADR 0008: Store message payloads as `json`, not `jsonb`

**Status:** accepted

## Context

The first schema used `jsonb`. During the first end-to-end run, a payload sent as
`{"order":42}` was delivered as `{"order": 42}`: `jsonb` normalises whitespace and reorders
object keys. Signatures were still valid (they're computed over what we send), but consumers
received different bytes from what the producer published, which is surprising and breaks
anyone hashing or diffing payloads.

## Decision

Use `json`, which stores the text as given. Hookline never queries inside payloads, so `jsonb`'s
indexing and operators bought nothing.

## Consequences

- The bytes delivered are exactly `JSON.stringify` of what the API received (tested in
  `queue.int.test.ts`: key order is preserved).
- Querying by payload fields would need `jsonb` or a generated column later.
