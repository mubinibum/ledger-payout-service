# ADR 0004: Modular monolith, not microservices

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The domain has a few clear modules (accounts, ledger, payouts, webhooks) and one background
concern (the payout worker). We need transactional consistency between accounts, ledger, and
payouts.

## Decision

Build a **modular monolith**: one HTTP deployable plus one worker process, sharing a single
PostgreSQL database. Modules live under `src/modules/<name>/` with their own routes,
services, and (later) repository code, and communicate through typed function calls — not
network hops.

- The money-critical path (create payout → debit ledger → enqueue) stays inside **one
  database transaction**. Splitting it across services would force a saga for no benefit at
  this scale.
- The worker is a separate *process* (own entrypoint, own scaling) but the same codebase and
  schema — so it can be reasoned about and deployed independently without distributed-systems
  overhead.

## Alternatives considered

- **Microservices** (accounts-svc, ledger-svc, payout-svc) — real operational cost,
  eventual consistency, and cross-service transactions, none of which this problem needs.
- **Single process for everything including the worker** — simplest, but long-running payout
  jobs would compete with request handling and couldn't be scaled separately.

## Consequences

- Two deployables to build and monitor (service + worker) — the ceiling stated in the
  non-goals.
- If a module ever genuinely needs independent deployment, its clean boundary makes
  extraction possible later; we don't pay for that option now.
