# webhooks (M3 / M3.1)

Inbound provider webhooks for final payout outcomes — see ADR 0016 / ADR 0018.

`POST /v1/webhooks/provider/payouts`

- **Verification** (`../../domain/webhook-signature.ts`): HMAC-SHA256 over
  `` `${timestamp}.${rawBody}` `` using the exact request bytes, constant-time compare,
  bounded clock skew. No secret → `503`. Bad signature / stale timestamp → `401`.
- **Replay protection & at-most-once apply** (`webhooks.service.ts`, one transaction):
  `INSERT ... ON CONFLICT DO NOTHING` on `provider_event_id`; a seen id with the same
  payload hash replays the first result (`200`), a different hash is `409`. A new event
  applies the settle/release transition (idempotent, terminal-wins). A **definitive**
  webhook can resolve a `manual_review` payout that has no accounting effect yet. A webhook
  that **contradicts** an already-applied terminal outcome is logged
  (`payout_outcome_conflict`), metered, acknowledged (`200`, `result: conflict_ignored`),
  and makes no second effect.
- The route registers a raw-body JSON parser **scoped to this plugin only**.

Never logs raw bodies, signatures, or the secret.
