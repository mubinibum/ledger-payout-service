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

/** BullMQ-backed `JobEnqueuer`. A deterministic `jobId` makes re-adds idempotent. */
export function bullEnqueuer(q: Queue = getPayoutQueue()): JobEnqueuer {
  return {
    async add(name, data, opts): Promise<void> {
      await q.add(name, data, { jobId: opts.jobId });
    },
  };
}

export async function closePayoutQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
