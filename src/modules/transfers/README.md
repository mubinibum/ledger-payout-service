# transfers (M2)

Internal balance transfers between two `active` accounts of the same currency.

Flow (one DB transaction, READ COMMITTED, retried on serialization failure / deadlock):

1. **Idempotency gate** — `beginIdempotent()` before any row lock. Fresh key → proceed;
   same key + same fingerprint → replay the first result; same key + different fingerprint
   → `409`.
2. **Lock** both accounts `FOR UPDATE` in ascending-id order (deterministic → no deadlock).
3. **Validate** against the locked rows: active, currency match, sufficient funds
   (non-overdraft accounts may not go negative).
4. **Write** the `transfer` ledger transaction, the two balanced entries, and the two
   balance projections.
5. **Finalize** the idempotency record (status `completed` + response snapshot) in the
   *same* transaction.

`POST /v1/transfers` (requires `Idempotency-Key`) · `GET /v1/transfers/:id` ·
`GET /v1/ledger-transactions/:id`. See ADR 0008 (locking) and ADR 0009 (idempotency).
