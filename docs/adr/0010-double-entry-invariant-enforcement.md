# ADR 0010: Enforcing the double-entry invariant in the database

- **Status:** accepted
- **Date:** 2026-08-29

## Context

The core accounting rule — every ledger transaction has **≥ 2 entries** whose **debits
equal its credits** — spans multiple rows, so a row-level `CHECK` cannot express it. The
service layer already builds balanced entries; the question is whether the database also
guarantees it.

## Decision

Add a **`DEFERRABLE INITIALLY DEFERRED` constraint trigger** on `ledger_entries`
(`assert_ledger_transaction_balanced()`), which runs **at `COMMIT`**:

- For the affected `ledger_transaction_id`, it counts entries and sums
  `credit → +amount, debit → -amount`.
- `< 2` entries, or a non-zero sum → `RAISE EXCEPTION` (`check_violation`), aborting the
  whole transaction.

Because it is deferred, partial state mid-transaction (first entry inserted, second not
yet) is fine — only the committed result is checked.

Sign convention (also ADR 0005): a `credit` increases an account's balance, a `debit`
decreases it; `amount_minor` is always positive.

## Alternatives considered

- **Service-layer only** — a bug or a future code path could persist an unbalanced
  transaction with nothing to stop it.
- **Immediate (non-deferred) trigger** — fires on the first entry insert, when the
  transaction is legitimately half-built; would force a specific insert protocol or a
  disable/enable dance.
- **`NUMERIC` running-total column with a CHECK** — doesn't capture the ≥ 2 / net-zero
  rule across rows.
- **Materialized "transaction balance" row updated per entry** — more moving parts than a
  commit-time assertion.

## Consequences

- A guaranteed invariant: an unbalanced transaction cannot exist after commit, regardless
  of how entries were written. Verified directly in
  `test/integration/transfers.test.ts` (a hand-built unbalanced pair is rejected at
  commit).
- The error surfaces at `COMMIT`, not at the offending `INSERT` — callers must treat commit
  as fallible (the transfer path already does).
- Trigger logic is plpgsql, versioned as migration `20260829_0002`.
