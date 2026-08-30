# outbox (M3)

Transactional outbox — see ADR 0013.

- `outbox.repository.ts`: `insertOutboxEvent` (called in the same transaction as the
  aggregate change), `claimPendingEvents` (`FOR UPDATE SKIP LOCKED`), `markEventPublished`,
  `markEventRetry` (backoff, `dead` after max attempts), `outboxStats`.
- `outbox.publisher.ts`: `OutboxPublisher` polls due `pending` events, enqueues each to the
  payout queue with **jobId = event id** (so a crash between enqueue and commit is safe),
  marks it published, and runs an optional side-effect (payout `requested → queued`) in the
  same transaction. Delivery is **at least once**.

Run it: `npm run publisher` (or `dev:publisher`).
