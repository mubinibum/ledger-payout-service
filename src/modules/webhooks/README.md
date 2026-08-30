# webhooks (M3)

Inbound provider webhooks for final payout outcomes — see ADR 0016.

`POST /v1/webhooks/provider/payouts`

- **Verification** (`../../domain/webhook-signature.ts`): HMAC-SHA256 over
  `` `${timestamp}.${rawBody}` `` using the exact request bytes, constant-time compare,
  bounded clock skew. No secret → `503`. Bad signature / stale timestamp → `401`.
- **Replay protection & once-only apply** (`webhooks.service.ts`, one transaction):
  `INSERT ... ON CONFLICT DO NOTHING` on `provider_event_id`; a seen id with the same
  payload hash replays the first result (`200`), a different hash is `409`. A new event
  applies the settle/release transition (idempotent, terminal-wins) and records the result.
- The route registers a raw-body JSON parser **scoped to this plugin only**.

Never logs raw bodies, signatures, or the secret.
