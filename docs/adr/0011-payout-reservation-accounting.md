# ADR 0011: Payout reservation accounting

- **Status:** accepted
- **Date:** 2026-08-30

## Context

A payout must not simply subtract from an account balance and hope the external transfer
succeeds. If it fails, the money has to come back; if it succeeds, the money has genuinely
left. Every movement must be a ledger transaction (ADR 0005/0010) so the books always
reconcile.

## Decision

Model a payout as **three balanced ledger transactions** against per-currency internal
system accounts:

| Step | When | Entries | Effect |
|---|---|---|---|
| **reservation** | create payout | debit `source`, credit `system:payout_holding` | funds leave the user, parked in holding |
| **settlement** | provider confirmed success | debit `system:payout_holding`, credit `system:provider_clearing` | money has left to the provider |
| **release** | permanent failure / cancel / reconciliation-not-found | debit `system:payout_holding`, credit `source` | funds returned to the user |

- Reservation happens **in the same transaction** as the payout row insert, the outbox
  event, and the idempotency record.
- `payouts.settlement_ledger_transaction_id` and `release_ledger_transaction_id` are the
  at-most-once guards: a DB CHECK forbids both being set; the transition code no-ops if the
  relevant one is already set (idempotent, terminal-wins).
- `system:payout_holding` and `system:provider_clearing` are `allow_overdraft = false`. If
  the state machine is correct, holding is only ever debited by an amount it was previously
  credited, so a negative balance means a bug — and the M2 `accounts_balance_nonneg` check
  aborts the transaction instead of persisting it.

## Alternatives considered

- **Debit source directly, credit it back on failure** — no holding account. Works, but
  loses the "in flight" state from the ledger and makes "how much is reserved right now?"
  a payout-table scan instead of one account balance.
- **A holding sub-account per user** — finer attribution, many more accounts, no benefit at
  this scope.

## Consequences

- Total value across `{source, holding, clearing}` is conserved by construction (every
  transaction balances). A test asserts it after 100+ parallel payouts.
- `provider_clearing` only ever grows — it is the ledger's record of money that left the
  system. A real system would periodically reconcile it against provider statements.
