# ADR 0013: Transactional outbox

- **Status:** accepted
- **Date:** 2026-08-30

## Context

"Create the payout, then enqueue a job" is a dual write across PostgreSQL and Redis. A
crash between the two loses the job — the payout is stuck in `requested` forever with funds
reserved and nothing driving it.

## Decision

Write an **outbox event in the same DB transaction** as the payout reservation
(`outbox_events`, status `pending`). A separate **publisher** process relays events:

```
loop every OUTBOX_POLL_INTERVAL_MS, in one transaction:
  SELECT ... FROM outbox_events
    WHERE status = 'pending' AND available_at <= now()
    ORDER BY available_at, created_at LIMIT OUTBOX_BATCH_SIZE
    FOR UPDATE SKIP LOCKED
  for each event:
    queue.add(job, payload, { jobId: event.id })   -- deterministic jobId
    UPDATE outbox_events SET status='published'      -- same transaction
    <payout side-effect: requested → queued>
  commit
```

- **`FOR UPDATE SKIP LOCKED`**: many publisher instances can poll concurrently; a row is
  never handed to two of them, and uncommitted producers are invisible.
- **Deterministic `jobId` = outbox event id**: if the process crashes after `queue.add`
  but before commit, the row stays `pending` and is re-enqueued next tick — BullMQ ignores
  the duplicate id. Delivery is therefore **at least once**; consumers are idempotent (ADR
  0015).
- An enqueue error (Redis down) increments `attempt_count` with a backoff; after
  `OUTBOX_MAX_ATTEMPTS` the event is parked as `dead` for an operator.
- The publisher holds the row lock across the `queue.add` network call. Acceptable at this
  scope; SKIP LOCKED means other publishers just move on. A very slow Redis would slow the
  relay, not corrupt it.

## Alternatives considered

- **Postgres `LISTEN/NOTIFY`** — no durability; a missed notification is a lost job.
- **Debezium / logical decoding CDC** — a whole additional system for one table.
- **Two-phase commit across PG and Redis** — Redis has no XA; not real.

## Consequences

- One extra insert per payout and a polling process to run.
- The outbox is a natural place to add more event types later (payout settled/failed for
  downstream consumers) without new plumbing.
