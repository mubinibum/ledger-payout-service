# webhooks (placeholder — M4)

Inbound provider webhooks: signature verification, idempotent application keyed on
`(payout_id, provider_event_id)`, retry with backoff, dead-letter after N attempts.
No implementation in M1.
