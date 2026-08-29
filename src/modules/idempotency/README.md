# idempotency (M2)

PostgreSQL-backed idempotency for mutating endpoints (transfers, funding).

- Table `idempotency_records`, unique on `(scope, idempotency_key)`.
- `request_hash` = SHA-256 of the canonical (recursively key-sorted) semantic payload plus
  the scope. Same key + same hash → replay the stored response; same key + different hash
  → `409 idempotency_conflict`.
- The pending record is inserted with `INSERT ... ON CONFLICT DO NOTHING` inside the
  operation's transaction, *before* any account lock. A concurrent same-key request blocks
  on that row until the first transaction resolves, then either replays (first committed)
  or proceeds (first rolled back). No error is raised, so the transaction stays usable.
- A record is only ever committed in the `completed` state, so a crash/restart cannot
  leave a poisoned key. Not Redis-backed; survives process restart.

See ADR 0009.
