# ADR 0005: Double-entry ledger direction

- **Status:** accepted (direction only — implementation lands in M2)
- **Date:** 2026-08-27

## Context

The service tracks account balances that change through transfers and payouts, with real
money semantics as the mental model: a balance must never be silently wrong, and money must
not be created or destroyed by a bug.

## Decision (direction)

Model value movement as **double-entry bookkeeping**:

- Every value movement is a **transaction** made of two or more **ledger entries** that sum
  to zero (debits negative, credits positive, or an explicit `direction` column).
- **Balance is a query** over ledger entries for an account — never a mutable `balance`
  column that can drift. A materialized/cached balance may be added later purely as an
  optimization, with a periodic check against the entries.
- Ledger entries are **append-only**. Corrections are new, reversing transactions, not
  updates or deletes.
- An account may be flagged `allows_negative` (a credit line); otherwise a transfer that
  would take it below zero is rejected.
- Concurrency on the same account is handled with row locking or a serializable-retry loop
  (decided and benchmarked in M2), and proven with a test that fires many concurrent
  transfers and asserts the invariant holds.

## Alternatives considered

- **Single mutable balance column** — simplest, but every concurrent writer races on one
  row, corrections lose history, and reconciliation has nothing to reconcile against.
- **Event sourcing the whole domain** — more machinery than needed; the ledger itself is
  already an append-only log, which captures the useful part.

## Consequences

- Reads compute balances (mitigated by an optional materialized balance + index).
- Every feature that moves value must define its entries so they sum to zero — enforced by
  tests, and ideally a DB constraint.
