# ADR 0017: Reconciliation policy

- **Status:** accepted
- **Date:** 2026-08-30

## Context

Webhooks are best-effort. A payout can sit in `submitted` (provider acknowledged, outcome
unknown) — especially after an ambiguous transport failure where the worker deliberately
did **not** release the funds. Something has to actively resolve those.

## Decision

`ReconciliationService.reconcileOnce()` (run by `src/reconcile.ts`, invoked on a schedule
the operator controls — M3 ships no scheduler):

1. Select non-terminal payouts (`submitted` / `processing`) whose `updated_at` is older
   than `RECONCILE_STALE_AFTER_SEC` and whose `reconcile_attempt_count <
   RECONCILE_MAX_ATTEMPTS`, with `FOR UPDATE SKIP LOCKED`.
2. For each, call `provider.getPayoutStatus(idempotencyKey)`:
   - **succeeded** → settle (idempotent).
   - **failed** → release (idempotent).
   - **pending** → bump `reconcile_attempt_count`, push `next_reconcile_at` out; **funds
     stay reserved**.
   - **unknown** (provider has no record) → reschedule until `RECONCILE_MAX_ATTEMPTS`, then
     release as `reconciliation_not_found`.

**Invariant: a timeout or an internal deadline never releases funds.** Only a definite
provider answer (`failed`, or exhausted `unknown`) does. This is why the worker parks
ambiguous outcomes in `submitted` instead of failing them.

The double-apply guard is the per-payout row lock inside every transition, not the claim —
so a worker and a reconciliation run (or two reconciliation runs) racing on one payout
still produce exactly one settlement or release.

## Alternatives considered

- **Release on stale timeout** — simple, but wrong: it can double-pay a beneficiary whose
  payout actually succeeded at the provider.
- **Never auto-resolve `unknown`** — funds could be reserved forever for a payout the
  provider genuinely never received. The bounded-attempts-then-release policy is the
  explicit, safe compromise, documented here and covered by a test.

## Consequences

- A stuck `submitted` payout is guaranteed to resolve within
  `RECONCILE_MAX_ATTEMPTS × reconcile interval`.
- `reconciliation_not_found` releases are a signal worth alerting on in a real deployment —
  they mean the provider lost a request we thought it had.
