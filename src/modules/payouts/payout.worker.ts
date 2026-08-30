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
 * Processes one payout job. Safe to run more than once — every step is idempotent and
 * terminal / submitted / manual_review payouts are left alone.
 *
 *  - transient error (provably never reached provider) → back to `queued`, BullMQ retries
 *  - permanent rejection (definitive)                  → release funds, `failed`
 *  - ambiguous outcome (may have reached provider)     → `submitted`, NEVER a release
 *  - `unknown` right after createPayout                → `submitted` (ambiguous), NOT retry
 */
export async function processPayoutJob(deps: PayoutWorkerDeps, ctx: JobContext): Promise<void> {
  const { payoutId } = ctx;
  const payout = await findPayoutById(deps.db, payoutId);
  if (!payout) {
    logger.warn({ payoutId }, 'payout_job_unknown_payout');
    return;
  }
  if (
    isTerminal(payout.status) ||
    payout.status === 'submitted' ||
    payout.status === 'manual_review'
  ) {
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
      await deps.service.applyProviderFailure(payoutId, {
        category,
        source: 'worker',
        definitiveSource: 'provider_rejection',
      });
      return;
    }
    if (classification === 'ambiguous') {
      // The provider MAY have received the request — do NOT release. `submitted` sets the
      // provider_contact marker; reconciliation / a webhook resolves it, or it ends up in
      // manual_review. Never an automatic release.
      metrics.providerAmbiguousOutcomesTotal.inc({ source: 'worker_create' });
      await deps.service.markSubmitted(payoutId, { ambiguous: true });
      return;
    }
    // transient: provably never reached the provider → back to queued, let BullMQ retry
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
        definitiveSource: 'provider_status',
      });
      return;
    case 'failed':
      await deps.service.applyProviderFailure(payoutId, {
        category: result.category,
        source: 'worker',
        definitiveSource: 'provider_status',
      });
      return;
    case 'unknown':
      // We just called createPayout and the provider reports no record. This is ambiguous
      // (the call may still have landed) — park it as `submitted`, do NOT retry-forever.
      metrics.providerAmbiguousOutcomesTotal.inc({ source: 'worker_unknown' });
      await deps.service.markSubmitted(payoutId, { ambiguous: true });
      return;
  }
}

/**
 * Called when BullMQ exhausts every attempt for a job.
 *
 * SAFETY (ADR 0018): auto-release ONLY when the payout is provably before any provider
 * submission — status `requested`/`queued` (the worker always moves to `processing` before
 * the provider call, and only returns to `queued` after a proven-not-reached transient
 * error) AND no `provider_contact` marker. Anything else → `manual_review`.
 */
export async function handleDeadLetter(deps: PayoutWorkerDeps, payoutId: string): Promise<void> {
  metrics.workerDlqTotal.inc();
  const payout = await findPayoutById(deps.db, payoutId);
  if (!payout) return;

  if (isTerminal(payout.status) || payout.status === 'manual_review') {
    return;
  }
  if (payout.status === 'submitted') {
    logger.warn({ payoutId }, 'payout_dead_letter_left_for_reconcile');
    return;
  }
  if ((payout.status === 'requested' || payout.status === 'queued') && !payout.provider_contact) {
    await deps.service.applyProviderFailure(payoutId, {
      category: 'transient_exhausted',
      source: 'worker',
      definitiveSource: 'worker',
    });
    logger.warn({ payoutId }, 'payout_dead_letter_released_never_reached_provider');
    return;
  }
  // processing, or provider_contact set → provider contact is possible → operator decides.
  await deps.service.markManualReview(payoutId, 'dlq_provider_contact_possible');
}

/** Wires `processPayoutJob` to a real BullMQ worker. Used by the worker process. */
export function createPayoutWorker(deps: PayoutWorkerDeps): Worker<PayoutJobData> {
  const env = loadEnv();
  const worker = new Worker<PayoutJobData>(
    env.PAYOUT_QUEUE_NAME,
    async (job: Job<PayoutJobData>) => {
      try {
        await processPayoutJob(deps, {
          payoutId: job.data.payoutId,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? env.WORKER_MAX_ATTEMPTS,
        });
        metrics.workerJobsTotal.inc({ result: 'completed' });
      } catch (err) {
        // On the final attempt an unexpected (non-transient) error would otherwise just
        // DLQ; route the payout to manual_review from here so it is never left stuck.
        const maxAttempts = job.opts.attempts ?? env.WORKER_MAX_ATTEMPTS;
        if (job.attemptsMade + 1 >= maxAttempts && !isProbablyTransient(err)) {
          await deps.service
            .markManualReview(job.data.payoutId, 'worker_unexpected_error')
            .catch(() => undefined);
        }
        throw err;
      }
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

function isProbablyTransient(err: unknown): boolean {
  return err instanceof ProviderError
    ? err.classification === 'transient'
    : classifyTransportError(err) === 'transient';
}
