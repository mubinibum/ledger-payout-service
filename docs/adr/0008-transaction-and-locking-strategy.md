# ADR 0008: Transaction isolation and locking strategy

- **Status:** accepted
- **Date:** 2026-08-29

## Context

Concurrent transfers touching the same account must not lose updates or drive a
non-overdraft balance negative. Two transfers touching the same *pair* of accounts in
opposite directions must not deadlock. The service runs as multiple stateless processes, so
the mechanism must live in the database, not in process memory.

## Decision

- **Isolation: READ COMMITTED** (PostgreSQL default).
- **Pessimistic row locks:** each transfer does
  `SELECT ... FROM accounts WHERE id IN (:a, :b) ORDER BY id ASC FOR UPDATE`, then verifies
  balances against the locked rows, writes entries + projections, and commits.
- **Deterministic lock order:** always ascending account id. Two transfers over the same
  pair therefore request the locks in the same order and queue instead of deadlocking.
- **Bounded retry:** a serialization failure (`40001`) or deadlock (`40P01`) retries the
  whole transaction up to `TRANSFER_MAX_RETRIES` (default 3) with small randomised backoff.
  With READ COMMITTED + ordered `FOR UPDATE` this should almost never fire; it is a
  backstop, and it increments a metric when it does.
- **No in-memory mutex / advisory-lock-per-process** — nothing that assumes a single
  instance.

## Alternatives considered

- **SERIALIZABLE + retry loop** — fewer explicit locks, but more frequent retries under
  contention and a heavier correctness-reasoning burden for a first cut. Kept as a possible
  future switch; the retry loop is already in place.
- **Atomic conditional `UPDATE ... WHERE balance >= :amount`** — works for the debit, but
  awkward to extend to multi-entry transactions and to reading `balance_after` consistently
  for both sides. `FOR UPDATE` keeps the whole unit under one clear lock.

## Consequences

- Transfers over a hot account serialise on that row — correct, but a throughput ceiling
  per account. Acceptable at this scope; documented.
- Lock ordering is load-bearing: any new multi-account write must lock in ascending id
  order too.
- Proven by `test/integration/concurrency.test.ts`: 150 concurrent transfers against a
  100-capacity source settle to exactly 100 success / 50 `insufficient_funds`, no negative
  balance, total value conserved, and bidirectional traffic over one pair never hangs.
