import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { loadEnv } from '../config/env.js';
import { redisConnectionOptions } from './redis.js';

/**
 * BullMQ backing connection. BullMQ requires `maxRetriesPerRequest: null` on its ioredis
 * connection (blocking commands), which is why it does not share the app's shared client.
 */
export function bullConnection(): ConnectionOptions {
  return redisConnectionOptions({ maxRetriesPerRequest: null, enableReadyCheck: false });
}

/** The minimal enqueue surface the outbox publisher depends on (keeps it unit-testable). */
export interface JobEnqueuer {
  add(name: string, data: Record<string, unknown>, opts: { jobId: string }): Promise<void>;
}

export const PAYOUT_JOB_NAME = 'process-payout';

let queue: Queue | undefined;

export function getPayoutQueue(): Queue {
  if (queue) return queue;
  const env = loadEnv();
  queue = new Queue(env.PAYOUT_QUEUE_NAME, {
    connection: bullConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
  return queue;
}

export function defaultJobOptions(): JobsOptions {
  const env = loadEnv();
  return {
    attempts: env.WORKER_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.WORKER_BACKOFF_MS },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  };
}

export class EnqueueTimeoutError extends Error {
  readonly code = 'OUTBOX_ENQUEUE_TIMEOUT';
  constructor(ms: number) {
    super(`queue.add did not complete within ${ms}ms`);
    this.name = 'EnqueueTimeoutError';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EnqueueTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * BullMQ-backed `JobEnqueuer`. A deterministic `jobId` makes re-adds idempotent, and each
 * `add` is bounded by `OUTBOX_ENQUEUE_TIMEOUT_MS` so a hung Redis cannot keep the outbox
 * publisher's DB row lock open indefinitely. On timeout the event is left `pending` and
 * retried next cycle; if the add actually landed, the jobId dedupes the duplicate.
 */
export function bullEnqueuer(
  q: Queue = getPayoutQueue(),
  timeoutMs: number = loadEnv().OUTBOX_ENQUEUE_TIMEOUT_MS,
): JobEnqueuer {
  return {
    async add(name, data, opts): Promise<void> {
      await withTimeout(q.add(name, data, { jobId: opts.jobId }), timeoutMs);
    },
  };
}

export async function closePayoutQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
