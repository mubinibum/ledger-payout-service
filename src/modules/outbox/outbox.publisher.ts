import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { isInjectedFault, maybeFault } from '../../infra/fault.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import { runInTransaction } from '../../infra/tx.js';
import { PAYOUT_JOB_NAME, type JobEnqueuer } from '../../infra/queue.js';
import {
  claimPendingEvents,
  markEventPublished,
  markEventRetry,
  type OutboxEventRow,
} from './outbox.repository.js';

/**
 * Runs after an event is marked published, inside the SAME transaction — used to nudge the
 * aggregate (e.g. payout `requested → queued`). Must be idempotent.
 */
export type OutboxSideEffect = (trx: Transaction<Database>, event: OutboxEventRow) => Promise<void>;

export interface OutboxPublisherOptions {
  batchSize: number;
  maxAttempts: number;
  backoffMs: number;
  pollIntervalMs: number;
  sideEffect?: OutboxSideEffect;
  /** Ran (best-effort) after each cycle — used to refresh domain safety gauges. */
  afterCycle?: () => Promise<void>;
}

function errorCategory(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'OUTBOX_ENQUEUE_TIMEOUT') return 'enqueue_timeout';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'redis_unavailable';
  if (typeof code === 'string') return code;
  return 'enqueue_failed';
}

/**
 * The transactional-outbox relay. It reads committed, due `pending` events, enqueues each
 * to the payout queue with a **deterministic jobId (the outbox event id)**, and marks it
 * published — all in one DB transaction. If the process crashes after `queue.add` but
 * before commit, the row stays `pending` and is re-enqueued next tick; BullMQ ignores the
 * duplicate jobId, and the worker is idempotent regardless. Delivery is **at least once**.
 */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly enqueuer: JobEnqueuer,
    private readonly opts: OutboxPublisherOptions,
  ) {}

  async runOnce(): Promise<{ published: number; retried: number }> {
    return runInTransaction(this.db, { maxRetries: 2 }, async (trx) => {
      // Safety net: if `queue.add` hangs and leaves the transaction idle past this window,
      // PostgreSQL aborts the session and releases the row locks (locks are never held
      // for an unbounded time behind a stuck Redis).
      const idleTimeoutMs = loadEnv().OUTBOX_ENQUEUE_TIMEOUT_MS + 5_000;
      await sql`SET LOCAL idle_in_transaction_session_timeout = ${sql.lit(idleTimeoutMs)}`.execute(
        trx,
      );

      const events = await claimPendingEvents(trx, this.opts.batchSize);
      let published = 0;
      let retried = 0;

      for (const event of events) {
        try {
          await this.enqueuer.add(
            PAYOUT_JOB_NAME,
            { outboxEventId: event.id, eventType: event.event_type, ...event.payload },
            { jobId: event.id },
          );
          maybeFault('after_enqueue_before_outbox_update');
          await markEventPublished(trx, event.id);
          if (this.opts.sideEffect) await this.opts.sideEffect(trx, event);
          published += 1;
          metrics.outboxPublishedTotal.inc({ event_type: event.event_type });
        } catch (err) {
          // An injected fault models a process crash — abort the whole transaction so the
          // event stays `pending` (exactly what a real crash would leave behind).
          if (isInjectedFault(err)) throw err;
          const category = errorCategory(err);
          await markEventRetry(trx, event.id, {
            errorCategory: category,
            backoffMs: this.opts.backoffMs,
            maxAttempts: this.opts.maxAttempts,
            currentAttempts: event.attempt_count,
          });
          retried += 1;
          metrics.outboxRetryTotal.inc({ category });
          logger.warn(
            { outboxEventId: event.id, eventType: event.event_type, category },
            'outbox_publish_retry',
          );
        }
      }

      return { published, retried };
    });
  }

  start(): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      if (this.running) {
        this.timer = setTimeout(tick, this.opts.pollIntervalMs);
        return;
      }
      this.running = true;
      this.inFlight = this.runOnce()
        .then(async (r) => {
          if (r.published > 0 || r.retried > 0) {
            logger.debug({ ...r }, 'outbox_cycle');
          }
          if (this.opts.afterCycle) await this.opts.afterCycle();
        })
        .catch((err: unknown) => logger.error({ err }, 'outbox_cycle_failed'))
        .finally(() => {
          this.running = false;
          if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollIntervalMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}

export function outboxPublisherOptionsFromEnv(): OutboxPublisherOptions {
  const env = loadEnv();
  return {
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    backoffMs: env.WORKER_BACKOFF_MS,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
  };
}
