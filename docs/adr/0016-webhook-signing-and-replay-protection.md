# ADR 0016: Webhook signing and replay protection

- **Status:** accepted
- **Date:** 2026-08-30

## Context

The provider reports final payout outcomes via `POST /v1/webhooks/provider/payouts`. The
endpoint is internet-facing in a real deployment: it must reject forged and replayed
requests, and apply genuine ones exactly once even under duplicates, reordering, and
concurrency.

## Decision

**Signature scheme** (generic, invented for this project):

```
signed_payload = `${timestamp}.${raw_body}`
signature      = hex(HMAC-SHA256(secret, signed_payload))
headers: x-provider-timestamp, x-provider-signature: sha256=<hex>, x-provider-event-id
```

- Verification uses the **raw request bytes** (a Fastify buffer parser scoped to this route
  only), a **constant-time** compare (`crypto.timingSafeEqual`), and a bounded clock-skew
  window (`WEBHOOK_TOLERANCE_SEC`). The body is parsed only after the signature passes.
- Secret from `WEBHOOK_SECRET`; with none set the endpoint returns `503` (fail closed).
- Failures return `401` with a generic message — no "bad signature" vs "bad timestamp"
  detail beyond the error code.

**Replay protection & once-only application** (PostgreSQL, one transaction):

1. `INSERT INTO provider_webhook_events (provider_event_id, ..., payload_hash)
   ON CONFLICT DO NOTHING`.
2. no row → the id was seen: same `payload_hash` → replay the stored result (`200`);
   different hash → `409 webhook_conflict`.
3. new row → look the payout up by idempotency key, apply the settle/release transition
   (idempotent, terminal-wins), record the result, commit.

A concurrent duplicate blocks on the unique `provider_event_id` and then replays — exactly
one accounting effect. If the transition is illegal for the current state, the transaction
rolls back (receipt included) and the provider gets a `409` to retry later.

## Alternatives considered

- **Verify against a re-serialised JSON object** — any key-order or whitespace difference
  breaks the signature.
- **Redis `SETNX` for replay** — not atomic with the ledger write.
- **No timestamp** — allows indefinite replay of a captured valid request.

## Consequences

- The webhook plugin overrides the JSON body parser in its own encapsulation context; the
  rest of the API is unaffected.
- Raw bodies, signatures and secrets are never logged.
