# ledger (M2)

Append-only double-entry postings.

- A **ledger transaction** (`funding | transfer`) groups two or more **ledger entries**.
- Each entry has a `direction` (`debit | credit`) and a **positive** `amount_minor`.
  Sign convention: `credit` increases an account's balance, `debit` decreases it.
- Invariant, per transaction: at least two entries, and `Σ credits == Σ debits`. Enforced
  by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that runs at `COMMIT`
  (`assert_ledger_transaction_balanced()`), on top of the service always building balanced
  entries. See ADR 0010.
- Committed transactions and their entries are **immutable** in M2. Corrections would be
  new reversing transactions (M3+).

Data access only (`ledger.repository.ts`) — the transfer/funding use cases live in the
`transfers` and `accounts` modules.
