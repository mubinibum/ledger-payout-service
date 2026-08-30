# ADR 0017: Reconciliation policy

- **Status:** accepted; the `unknown`-after-`RECONCILE_MAX_ATTEMPTS` → release rule is
  **superseded by [ADR 0018](0018-ambiguous-outcomes-and-manual-review.md)** (M3.1). An
  `unknown` result now keeps the funds reserved and, at the attempt budget, routes the
  payout to `manual_review` instead of releasing it.
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
   - **unknown** (provider has no record) → **[revised by ADR 0018]** originally: reschedule
     then release as `reconciliation_not_found` at `RECONCILE_MAX_ATTEMPTS`. Now: keep the
     funds reserved and route to `manual_review` at the attempt budget (an `unknown` is only
     released when the adapter's `capabilities().notFoundIsDefinitive` is true).

**Invariant: a timeout or an internal deadline never releases funds.** Only a definitive
provider answer does. This is why the worker parks ambiguous outcomes in `submitted`
instead of failing them.

The double-apply guard is the per-payout row lock inside every transition, not the claim —
so a worker and a reconciliation run (or two reconciliation runs) racing on one payout
still produce exactly one settlement or release.

## Alternatives considered

- **Release on stale timeout** — simple, but wrong: it can double-pay a beneficiary whose
  payout actually succeeded at the provider.
- **Auto-release `unknown` after N attempts** (the original decision) — rejected in ADR
  0018: it can double-pay a beneficiary whose payout actually succeeded. ADR 0018 keeps the
  funds reserved and hands the payout to an operator (`manual_review`) instead.

## Consequences

- A stuck `submitted` payout is guaranteed to be acted on within
  `RECONCILE_MAX_ATTEMPTS × reconcile interval` — settled/released on a definitive answer,
  otherwise moved to `manual_review` (ADR 0018), never left drifting.
