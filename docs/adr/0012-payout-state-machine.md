# ADR 0012: Payout state machine

- **Status:** accepted; the transition matrix is **extended in M3.1** by
  [ADR 0018](0018-ambiguous-outcomes-and-manual-review.md) with the non-terminal
  `manual_review` state.
- **Date:** 2026-08-30

## Context

A payout moves through create → queue → worker → provider → (webhook | reconciliation).
Several actors can act on the same payout, some concurrently, some out of order. Without a
single explicit state model, transition rules end up copy-pasted across routes, the worker,
the webhook handler and reconciliation, and drift.

## Decision

One state enum and one transition matrix in `src/domain/payout-state.ts`:

```
requested     → queued | processing | cancelled | failed | manual_review
queued        → processing | cancelled | failed | manual_review
processing    → submitted | succeeded | failed | queued | manual_review
submitted     → succeeded | failed | manual_review
manual_review → succeeded | failed | submitted        (ADR 0018 — explicit resolution only)
succeeded | failed | cancelled → (terminal, no transitions)
```

(`requested`/`queued → failed` is the dead-letter release of a payout provably never
submitted; `processing → queued` is a proven-not-reached transient retry.)

- `submitted` means "the provider acknowledged the request; the outcome is not yet known".
  It is reached on an explicit `accepted` response **and** on an ambiguous transport
  failure (timeout / reset after send).
- Only `requested` / `queued` are cancellable — once a worker may have talked to the
  provider, the API returns `409 payout_not_cancellable`.
- Every transition goes through `assertTransition(from, to)`. Re-applying the same state is
  a no-op (callers check first). All accounting transitions also lock the payout row
  `FOR UPDATE` before touching state, so concurrent actors serialise.
- Failure taxonomy the machine distinguishes: **transient technical** (retry), **permanent
  rejection** (release + `failed`), **ambiguous** (`submitted`, never a release), **confirmed
  success/failure** (settle / release).

## Alternatives considered

- **Fewer states** (drop `queued` or `submitted`) — `submitted` is load-bearing: it is
  what stops an ambiguous outcome from releasing funds. `queued` is cheap and makes the API
  status honest ("it's on the queue").
- **A generic state-machine library** — more indirection than a 7-state enum and a
  `Record<Status, Set<Status>>` needs.

## Consequences

- Illegal transitions surface as `409 invalid_payout_transition` (e.g. a `succeeded`
  webhook for a payout still in `requested`), which makes a misbehaving provider retry
  rather than corrupt state.
- Terminal-wins is explicit: a late `failed` webhook after `succeeded` is a logged no-op.
