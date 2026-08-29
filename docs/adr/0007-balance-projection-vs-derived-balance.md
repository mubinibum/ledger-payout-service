# ADR 0007: Cached balance projection vs. purely derived balance

- **Status:** accepted (refines ADR 0005)
- **Date:** 2026-08-29

## Context

ADR 0005 said "balance is a query". A purely derived balance
(`SELECT SUM(...) FROM ledger_entries WHERE account_id = ?`) is simple and impossible to
desync, but the overdraft check on the write path then needs that aggregate under a lock on
every transfer, and it grows O(entries) forever.

## Decision

Keep a **cached projection**: `accounts.balance_minor`, plus `balance_after` on every
ledger entry.

- The projection is only ever updated **in the same DB transaction** as the entries that
  move it, after the entries are written.
- The write path locks the account rows `FOR UPDATE`, so the projection it reads is current
  and cannot be updated concurrently.
- `balance_after` on each entry is the running balance at that entry — an audit trail and a
  cheap cross-check: a test replays the entries and asserts the derived balance equals the
  projection, and that total value across all accounts is conserved by internal transfers.

The ledger entries remain the source of truth; the projection is a derived cache that
happens to be stored.

## Alternatives considered

- **Purely derived, no column** — clean, but couples every overdraft check to a growing
  aggregate and a wider lock.
- **Projection updated by a trigger** — moves core business math into the database and
  makes it invisible to the application tests; rejected.
- **Async projection (event/outbox)** — needed only at much larger scale; premature here
  and would make the overdraft check eventually-consistent, which is wrong for money.

## Consequences

- Two places hold a balance; they can only diverge through a bug, and a test guards it.
- Reads are O(1). History is keyset-paginated over `(created_at, id)`.
