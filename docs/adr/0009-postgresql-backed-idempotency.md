# ADR 0009: PostgreSQL-backed idempotency

- **Status:** accepted
- **Date:** 2026-08-29

## Context

`POST /v1/transfers` must be safe to retry: a repeat with the same `Idempotency-Key` and
payload must not move money twice, two parallel requests with one key must produce one
transfer, a different payload under the same key must be rejected, and the guarantee must
survive a process restart. Redis alone cannot give "the idempotency record and the ledger
write commit atomically".

## Decision

Store idempotency in PostgreSQL, in the **same transaction** as the operation.

- Table `idempotency_records`, unique `(scope, idempotency_key)`.
- **Fingerprint:** `sha256(scope + "\n" + canonicalJson(semantic fields))`, where
  `canonicalJson` recursively sorts object keys and drops `undefined`. Stored as
  `request_hash`. No headers, timestamps, or secrets go into it.
- **Gate** (`beginIdempotent`), run before any account lock:
  `INSERT ... ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING *`.
  - Row returned → we own this key; do the work; `UPDATE` the row to `completed` with the
    response snapshot and status code, still inside the transaction.
  - No row → the key exists. A concurrent uncommitted insert *blocks* here until the owner
    commits or rolls back (that is what serialises parallel same-key requests). Then read
    the row: different `request_hash` → `409`; `completed` → replay the snapshot.
- `ON CONFLICT DO NOTHING` rather than catching a unique-violation error: a raised error
  would abort the surrounding transaction and break the follow-up read.
- A record is only ever *committed* as `completed` (the pending row lives and dies inside
  its owning transaction). A crash therefore leaves no poisoned key, and no TTL/reaper is
  needed in M2. A business-rule failure (e.g. insufficient funds) rolls the pending row
  back with everything else — no fake success is stored, and a later retry is free to try
  again.

## Alternatives considered

- **Redis `SET NX`** — fast, but not atomic with the DB write; a crash between the two
  leaves them inconsistent. Rejected as the source of truth (may become a fast-path cache
  later).
- **Catch `23505`** — simplest to write, but poisons the transaction in PostgreSQL.
- **Advisory lock on `hash(key)`** — serialises correctly but stores no result to replay
  and no payload to detect a conflict.

## Consequences

- One extra insert + one update per mutating request.
- Same-key requests serialise (block) rather than racing — intended.
- `response_snapshot` is capped small (the transfer/txn view); no raw request body stored.
