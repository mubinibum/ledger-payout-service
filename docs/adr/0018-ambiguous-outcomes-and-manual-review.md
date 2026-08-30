# ADR 0018: Ambiguous provider outcomes and manual review

- **Status:** accepted (M3.1 — supersedes the "release on `unknown` after max attempts"
  part of ADR 0017)
- **Date:** 2026-08-31

## Context

M3 reconciliation released reserved payout funds after `RECONCILE_MAX_ATTEMPTS` on an
`unknown` provider status, and the worker's dead-letter handler released a payout that had
reached `processing`. In both cases **the provider may actually have paid the
beneficiary**. Auto-releasing then lets the user receive the payout *and* get the reserved
amount back — a double-spend.

The same risk exists for: HTTP 5xx, response timeouts, connection resets, an unparseable
provider response, a generic `not_found`, a payout landing in the BullMQ dead-letter queue,
and any "we ran out of attempts / time" condition.

## Decision

### Safety rule

> Reserved payout funds are released automatically **only** after a definitive,
> contractually-reliable provider rejection, or a user cancellation **before any provider
> submission attempt**.

Concretely, the *only* automatic releases are:

1. a definitive provider rejection — an explicit 4xx from `createPayout`, a signed
   `payout.failed` webhook, or a `getPayoutStatus` that definitively reports failed;
2. `unknown`/`not_found` **only if** the adapter's
   `capabilities().notFoundIsDefinitive === true` (the provider contractually guarantees
   the request was never accepted);
3. a dead-letter for a payout still in `requested`/`queued` with `provider_contact = false`
   — the worker always moves to `processing` before calling the provider and only returns
   to `queued` after a *proven-not-reached* transient error, so this is provably
   pre-submission;
4. a public cancellation while `requested`/`queued` and `provider_contact = false`.

**Nothing else releases.** Timeouts, resets, 5xx, unknown status, a missing webhook, an
exhausted attempt/reconcile budget, a DLQ with possible provider contact → the payout goes
to `manual_review`.

### `manual_review` state

A new **non-terminal** payout status:

- funds stay in `system:payout_holding` (no settlement, no release — a DB CHECK enforces
  this);
- automatic processing stops (the worker and reconciliation ignore it);
- it is **not cancellable** through the public API;
- it leaves only through an explicit internal resolution:
  `manual_review → succeeded` (settle), `→ failed` (release), or `→ submitted` (operator
  says it is safe to let reconciliation try again). Never back to `requested`/`queued`/
  `cancelled`.

Resolution is operator-only. There is no public HTTP admin endpoint (no authn/authz yet);
`src/payout-admin.ts` is a local CLI. Every resolution — including a rejected contradictory
one — writes a `payout_resolutions` audit row (payout id, previous/new status, resolution,
reason, operator reference, resulting ledger transaction id, timestamp; no credentials, no
personal data).

### Provider outcome taxonomy

| Bucket | Examples | Action |
|---|---|---|
| **definitive success** | signed success webhook; status query says paid | settle (once) |
| **definitive failure** | explicit 4xx rejection; signed failure webhook; status says failed; `not_found` **iff** `notFoundIsDefinitive` | release (once) |
| **safe-to-retry** | connection refused / DNS before send; local validation/circuit-open | retry with the same idempotency key; if the budget is spent and `provider_contact = false`, release; otherwise `manual_review` |
| **ambiguous** | timeout, reset, 5xx (default), unparseable response, generic `not_found`, conflicting webhook/status, retry exhaustion with possible contact | never release → `submitted` → reconcile → `manual_review` |

`classifyTransportError` **defaults to `ambiguous`** — an unrecognised error is never
guessed in our favour. A `ProviderCapabilities` object on the adapter (conservative
defaults: `notFoundIsDefinitive: false`, `fivexxIsDefinitiveNonProcessing: false`) is the
single place a real adapter opts into stronger guarantees.

### Contradictory outcomes

A webhook or status that contradicts an already-applied terminal accounting effect
(`payout.failed` after settled, `payout.succeeded` after released) is **logged**
(`payout_outcome_conflict`), **metered** (`payout_outcome_conflicts_total`), acknowledged
(`200`, `result: conflict_ignored`), and produces **no second effect**. Terminal wins; a
human investigates.

## Alternatives considered

- **Keep releasing on `unknown` after N attempts** (M3 behaviour) — the double-spend this
  ADR exists to close.
- **Never resolve `manual_review` automatically, even via a definitive signed webhook** —
  too conservative; a later definitive answer should still settle/release a
  `manual_review` payout that has no accounting effect yet.
- **A `needs_review` boolean instead of a status** — the state machine already gates every
  transition; a status keeps "no automatic processing" and "not cancellable" in one place
  and visible in `GET /v1/payouts?status=manual_review`.

## Consequences

- A stuck ambiguous payout is guaranteed to reach `manual_review` within
  `RECONCILE_MAX_ATTEMPTS × interval` and then waits for an operator — it never
  auto-resolves in either direction.
- Operators need a runbook for the `manual_review` queue (see the README runbook draft).
  New gauges surface the backlog: `payout_manual_review`,
  `payout_manual_review_oldest_seconds`, `payouts_reserved_beyond_threshold`,
  `outbox_dead_with_reserved_payout`.
- Processing is **at-least-once delivery + idempotent accounting effects + at-most-once
  settlement/release per payout**. It is **not** exactly-once.
