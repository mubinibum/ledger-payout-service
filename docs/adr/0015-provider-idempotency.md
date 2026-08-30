# ADR 0015: Provider idempotency

- **Status:** accepted
- **Date:** 2026-08-30

## Context

The worker retries `createPayout` on transient errors, and reconciliation may also poke the
provider. None of that may result in the beneficiary being paid twice.

## Decision

- Every payout has a **stable provider idempotency key = its `external_id`** (client-supplied
  or generated once at creation, stored in `payouts.provider_idempotency_key`, unique).
- The `ProviderPort` contract requires `createPayout` to be idempotent on that key: a
  repeat returns the original provider result, never a second payout.
- The worker always sends the same key for a given payout, on every attempt.
- Reconciliation looks the payout up by the same key (`getPayoutStatus(idempotencyKey)`).
- The mock provider enforces this: its store is keyed by the idempotency key and a repeat
  `POST /payouts` replays the stored result.

## Alternatives considered

- **Key = internal payout UUID** — also stable, but `external_id` is the reference the
  client already knows and can use to reconcile on their side; keeping them the same is one
  less identifier.
- **Key = a hash of the request** — breaks if any non-semantic field changes between
  retries.

## Consequences

- `external_id` must be immutable for the life of a payout (it is — payouts are only
  updated through state transitions, never re-addressed).
- A real provider adapter must map this key onto whatever idempotency mechanism that
  provider offers (header, body field, pre-registered key).
