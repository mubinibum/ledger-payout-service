import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { maybeFault } from '../../infra/fault.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import type { ProviderPort } from '../provider/provider.port.js';
import { refreshPayoutSafetyGauges } from './payout-metrics.js';
import type { PayoutsService } from './payouts.service.js';

export interface ReconcileSummary {
  candidates: number;
  settled: number;
  released: number;
  stillPending: number;
  manualReview: number;
  errors: number;
}

/**
 * Resolves non-terminal payouts (`submitted` / `processing`) that have been quiet longer
 * than `RECONCILE_STALE_AFTER_SEC`, by asking the provider directly.
 *
 * Policy (ADR 0018):
 *  - provider says succeeded            → settle
 *  - provider says failed (definitive)  → release
 *  - provider says pending / accepted   → keep reserved, reschedule
 *  - provider has no record (`unknown`) → keep reserved. Only release if the adapter's
 *    `capabilities().notFoundIsDefinitive` is true (the provider contractually guarantees
 *    the request was never accepted).
 *  - `RECONCILE_MAX_ATTEMPTS` reached while still non-definitive → `manual_review`
 *  - a malformed status or an internal error                    → reschedule; after the
 *    attempt budget → `manual_review`
 *  - a timeout / internal deadline alone NEVER releases funds.
 */
export class ReconciliationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly payouts: PayoutsService,
    private readonly provider: ProviderPort,
  ) {}

  async reconcileOnce(): Promise<ReconcileSummary> {
    metrics.reconciliationRunsTotal.inc();
    const env = loadEnv();
    const maxAttempts = env.RECONCILE_MAX_ATTEMPTS;
    const notFoundIsDefinitive = this.provider.capabilities().notFoundIsDefinitive;
    const candidates = await this.payouts.findStaleForReconcile();
    const summary: ReconcileSummary = {
      candidates: candidates.length,
      settled: 0,
      released: 0,
      stillPending: 0,
      manualReview: 0,
      errors: 0,
    };

    for (const payout of candidates) {
      const isLastAttempt = payout.reconcile_attempt_count + 1 >= maxAttempts;
      try {
        const status = await this.provider.getPayoutStatus(payout.provider_idempotency_key);
        maybeFault('reconciliation_transition');

        switch (status.kind) {
          case 'succeeded':
            await this.payouts.applyProviderSuccess(payout.id, {
              providerPayoutId: status.providerPayoutId,
              source: 'reconciliation',
              definitiveSource: 'provider_status',
            });
            summary.settled += 1;
            metrics.reconciliationOutcomesTotal.inc({ outcome: 'settled' });
            break;

          case 'failed':
            await this.payouts.applyProviderFailure(payout.id, {
              category: status.category,
              source: 'reconciliation',
              definitiveSource: 'provider_status',
            });
            summary.released += 1;
            metrics.reconciliationOutcomesTotal.inc({ outcome: 'released' });
            break;

          case 'accepted':
          case 'pending':
            if (isLastAttempt) {
              await this.payouts.markManualReview(payout.id, 'reconciliation_exhausted');
              summary.manualReview += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'manual_review' });
            } else {
              await this.payouts.rescheduleReconcile(payout.id, 'pending');
              summary.stillPending += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'pending' });
            }
            break;

          case 'unknown':
            if (notFoundIsDefinitive) {
              await this.payouts.applyProviderFailure(payout.id, {
                category: 'definitive_not_found',
                source: 'reconciliation',
                definitiveSource: 'provider_status',
              });
              summary.released += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'released_definitive_not_found' });
            } else if (isLastAttempt) {
              await this.payouts.markManualReview(payout.id, 'reconciliation_exhausted');
              summary.manualReview += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'manual_review' });
            } else {
              await this.payouts.rescheduleReconcile(payout.id, 'unknown');
              summary.stillPending += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'not_found_retry' });
            }
            break;
        }
      } catch (err) {
        summary.errors += 1;
        metrics.reconciliationOutcomesTotal.inc({ outcome: 'error' });
        logger.error({ err, payoutId: payout.id }, 'reconcile_payout_failed');
        // A malformed status or an internal error: never release. Reschedule; after the
        // attempt budget, hand it to an operator.
        if (isLastAttempt) {
          await this.payouts
            .markManualReview(payout.id, 'malformed_provider_status')
            .catch(() => undefined);
          summary.manualReview += 1;
        } else {
          await this.payouts.rescheduleReconcile(payout.id, 'error').catch(() => undefined);
        }
      }
    }

    await refreshPayoutSafetyGauges(this.db);
    if (summary.candidates > 0) logger.info({ ...summary }, 'reconcile_cycle');
    return summary;
  }
}
