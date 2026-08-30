import { loadEnv } from '../../config/env.js';
import { maybeFault } from '../../infra/fault.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import type { ProviderPort } from '../provider/provider.port.js';
import type { PayoutsService } from './payouts.service.js';

export interface ReconcileSummary {
  candidates: number;
  settled: number;
  released: number;
  stillPending: number;
  errors: number;
}

/**
 * Resolves non-terminal payouts that have been quiet longer than `RECONCILE_STALE_AFTER_SEC`
 * by asking the provider directly (`getPayoutStatus`) using our stable idempotency key.
 *
 * Policy:
 *  - provider says succeeded / failed  → settle / release (idempotent)
 *  - provider says pending             → bump attempt, reschedule; funds stay reserved
 *  - provider has no record            → reschedule until `RECONCILE_MAX_ATTEMPTS`, then
 *    release as `reconciliation_not_found` (the provider definitively never took it)
 *  - a timeout / internal deadline alone NEVER releases funds — only a definite provider
 *    answer does.
 */
export class ReconciliationService {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly provider: ProviderPort,
  ) {}

  async reconcileOnce(): Promise<ReconcileSummary> {
    metrics.reconciliationRunsTotal.inc();
    const env = loadEnv();
    const candidates = await this.payouts.findStaleForReconcile();
    const summary: ReconcileSummary = {
      candidates: candidates.length,
      settled: 0,
      released: 0,
      stillPending: 0,
      errors: 0,
    };

    for (const payout of candidates) {
      try {
        const status = await this.provider.getPayoutStatus(payout.provider_idempotency_key);
        maybeFault('reconciliation_transition');
        switch (status.kind) {
          case 'succeeded':
            await this.payouts.applyProviderSuccess(payout.id, {
              providerPayoutId: status.providerPayoutId,
              source: 'reconciliation',
            });
            summary.settled += 1;
            metrics.reconciliationOutcomesTotal.inc({ outcome: 'settled' });
            break;
          case 'failed':
            await this.payouts.applyProviderFailure(payout.id, {
              category: status.category,
              source: 'reconciliation',
            });
            summary.released += 1;
            metrics.reconciliationOutcomesTotal.inc({ outcome: 'released' });
            break;
          case 'accepted':
          case 'pending':
            await this.payouts.rescheduleReconcile(payout.id);
            summary.stillPending += 1;
            metrics.reconciliationOutcomesTotal.inc({ outcome: 'pending' });
            break;
          case 'unknown':
            if (payout.reconcile_attempt_count + 1 >= env.RECONCILE_MAX_ATTEMPTS) {
              await this.payouts.applyProviderFailure(payout.id, {
                category: 'reconciliation_not_found',
                source: 'reconciliation',
              });
              summary.released += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'released_not_found' });
            } else {
              await this.payouts.rescheduleReconcile(payout.id);
              summary.stillPending += 1;
              metrics.reconciliationOutcomesTotal.inc({ outcome: 'not_found_retry' });
            }
            break;
        }
      } catch (err) {
        summary.errors += 1;
        metrics.reconciliationOutcomesTotal.inc({ outcome: 'error' });
        logger.error({ err, payoutId: payout.id }, 'reconcile_payout_failed');
        await this.payouts.rescheduleReconcile(payout.id).catch(() => undefined);
      }
    }

    if (summary.candidates > 0) logger.info({ ...summary }, 'reconcile_cycle');
    return summary;
  }
}
