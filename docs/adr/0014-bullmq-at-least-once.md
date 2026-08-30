# ADR 0014: BullMQ worker, at-least-once delivery

- **Status:** accepted
- **Date:** 2026-08-30

## Context

The payout worker consumes jobs from the outbox relay, calls the provider, and drives the
payout to a terminal state. It must survive worker crashes, provider flakiness, and
duplicate deliveries, and it must run as its own process (not inside the API).

## Decision

**BullMQ** (Redis-backed) for the queue; the worker is `src/worker.ts`, a separate entry
point.

- **Delivery is at least once.** `processPayoutJob` is idempotent: it re-loads the payout,
  returns immediately if it is terminal or already `submitted`, and every transition is
  guarded by the payout row lock and the settlement/release flags.
- **Bounded retries with exponential backoff + jitter** (`WORKER_MAX_ATTEMPTS`,
  `WORKER_BACKOFF_MS`). A transient error re-throws so BullMQ retries; a permanent
  rejection releases and does not retry; an ambiguous outcome moves to `submitted` and does
  **not** retry (reconciliation owns it).
- **Provider idempotency key = the payout's stable `external_id`**, sent on every attempt,
  so a retry never creates a second provider-side payout (ADR 0015).
- **Dead-letter**: when attempts are exhausted, the `failed` handler releases the funds
  **only if** the payout never reached `submitted` (the provider definitely never took it);
  a `submitted` payout is left for reconciliation.
- **Graceful shutdown**: `worker.close()` waits for the in-flight job; an interrupted job's
  lock expires and it is redelivered — no acknowledged work is lost.

## Alternatives considered

- **A Postgres-based queue** (`SELECT ... FOR UPDATE SKIP LOCKED` on a jobs table) — would
  remove Redis, but reinvents retry/backoff/delay/DLQ that BullMQ already provides, and the
  project already commits to Redis.
- **Exactly-once delivery** — not offered by any queue over an unreliable network without a
  distributed transaction; idempotent consumers are the honest design.

## Consequences

- Redis is now on the critical path for payouts (not for M2 transfers).
- Two more processes to run locally (`publisher`, `worker`); documented in the README.
