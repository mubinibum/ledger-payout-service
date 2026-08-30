import { Worker, type Job } from 'bullmq';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { InvalidPayoutTransitionError, isTerminal } from '../../domain/payout-state.js';
import { ProviderError, classifyTransportError } from '../../domain/provider-outcome.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import { bullConnection, PAYOUT_JOB_NAME } from '../../infra/queue.js';
import { findPayoutById } from './payouts.repository.js';
import type { PayoutsService } from './payouts.service.js';
import type { ProviderPort } from '../provider/provider.port.js';

export interface PayoutJobData {
  payoutId: string;
  outboxEventId?: string;
  eventType?: string;
}

export interface PayoutWorkerDeps {
  db: Kysely<Database>;
  service: PayoutsService;
  provider: ProviderPort;
}

export interface JobContext {
  payoutId: string;
  attemptsMade: number;
  maxAttempts: number;
}

/**
 * Processes one payout job. Safe to run more than once for the same payout — every step is
 * idempotent and terminal / submitted payouts are left alone. A transient failure re-throws
 * so BullMQ retries; a permanent failure releases the funds; an ambiguous outcome moves the
 * payout to `submitted` and leaves resolution to a webhook or reconciliation (never a
 * release).
 */
export async function processPayoutJob(deps: PayoutWorkerDeps, ctx: JobContext): Promise<void> {
  const { payoutId } = ctx;
  const payout = await findPayoutById(deps.db, payoutId);
  if (!payout) {
    logger.warn({ payoutId }, 'payout_job_unknown_payout');
    return;
  }
  if (isTerminal(payout.status) || payout.status === 'submitted') {
    logger.debug({ payoutId, status: payout.status }, 'payout_job_noop');
    return;
  }

  try {
    await deps.service.markProcessing(payoutId);
  } catch (err) {
    if (err instanceof InvalidPayoutTransitionError) return; // raced with cancel / terminal
    throw err;
  }

  let result;
  try {
    result = await deps.provider.createPayout({
      idempotencyKey: payout.provider_idempotency_key,
      amountMinor: payout.amount_minor,
      currency: payout.currency.trim(),
      reference: payout.external_id,
    });
  } catch (err) {
    const classification =
      err instanceof ProviderError ? err.classification : classifyTransportError(err);
    metrics.providerErrorsTotal.inc({ classification });

    if (classification === 'permanent') {
      const category =
        err instanceof ProviderError && err.providerCategory
          ? err.providerCategory
          : 'permanent_rejection';
      await deps.service.applyProviderFailure(payoutId, { category, source: 'worker' });
      return;
    }
    if (classification === 'ambiguous') {
      // The provider may have received the request — do NOT release. Reconciliation resolves.
      await deps.service.markSubmitted(payoutId, { ambiguous: true });
      return;
    }
    // transient: back to queued, let BullMQ retry
    await deps.service.markRetrying(payoutId);
    metrics.workerRetryTotal.inc();
    throw err instanceof Error ? err : new Error('transient provider error');
  }

  metrics.providerAttemptsTotal.inc({ outcome: result.kind });
  switch (result.kind) {
    case 'accepted':
    case 'pending':
      await deps.service.markSubmitted(payoutId, { providerPayoutId: result.providerPayoutId });
      return;
    case 'succeeded':
      await deps.service.applyProviderSuccess(payoutId, {
        providerPayoutId: result.providerPayoutId,
        source: 'worker',
      });
      return;
    case 'failed':
      await deps.service.applyProviderFailure(payoutId, {
        category: result.category,
        source: 'worker',
      });
      return;
    case 'unknown':
      // We just called createPayout and the provider has no record — treat as transient.
      await deps.service.markRetrying(payoutId);
      throw new Error('provider returned unknown for a freshly submitted payout');
  }
}

/** When BullMQ exhausts every attempt, release only if the provider never took the request. */
export async function handleDeadLetter(deps: PayoutWorkerDeps, payoutId: string): Promise<void> {
  metrics.workerDlqTotal.inc();
  const payout = await findPayoutById(deps.db, payoutId);
  if (!payout) return;
  if (
    payout.status === 'requested' ||
    payout.status === 'queued' ||
    payout.status === 'processing'
  ) {
    await deps.service.applyProviderFailure(payoutId, {
      category: 'transient_exhausted',
      source: 'worker',
    });
    logger.warn({ payoutId }, 'payout_dead_letter_released');
  } else {
    logger.warn({ payoutId, status: payout.status }, 'payout_dead_letter_left_for_reconcile');
  }
}

/** Wires `processPayoutJob` to a real BullMQ worker. Used by the worker process. */
export function createPayoutWorker(deps: PayoutWorkerDeps): Worker<PayoutJobData> {
  const env = loadEnv();
  const worker = new Worker<PayoutJobData>(
    env.PAYOUT_QUEUE_NAME,
    async (job: Job<PayoutJobData>) => {
      await processPayoutJob(deps, {
        payoutId: job.data.payoutId,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? env.WORKER_MAX_ATTEMPTS,
      });
      metrics.workerJobsTotal.inc({ result: 'completed' });
    },
    {
      connection: bullConnection(),
      concurrency: env.WORKER_CONCURRENCY,
      autorun: true,
    },
  );

  worker.on('failed', (job, err) => {
    if (!job || job.name !== PAYOUT_JOB_NAME) return;
    metrics.workerJobsTotal.inc({ result: 'failed_attempt' });
    const maxAttempts = job.opts.attempts ?? env.WORKER_MAX_ATTEMPTS;
    if (job.attemptsMade >= maxAttempts) {
      handleDeadLetter(deps, job.data.payoutId).catch((e: unknown) =>
        logger.error({ err: e, payoutId: job.data.payoutId }, 'dead_letter_handler_failed'),
      );
    }
    logger.warn(
      { payoutId: job.data.payoutId, attempt: job.attemptsMade, err: err.message },
      'payout_job_attempt_failed',
    );
  });

  return worker;
}
