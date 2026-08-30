import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { metrics } from '../../infra/metrics.js';
import { payoutSafetyStats } from './payouts.repository.js';

/**
 * Refresh the payout safety gauges. Cheap; called from the reconciliation pass and the
 * outbox publisher loop so the "stuck reservation" / "manual review backlog" / "dead outbox
 * event with reserved payout" numbers stay current without a dedicated process.
 */
export async function refreshPayoutSafetyGauges(db: Kysely<Database>): Promise<void> {
  const stats = await payoutSafetyStats(db, loadEnv().RESERVED_PAYOUT_ALERT_SEC);
  metrics.payoutManualReviewGauge.set(stats.manualReview);
  metrics.payoutManualReviewOldestSecondsGauge.set(stats.manualReviewOldestSeconds ?? 0);
  metrics.payoutsReservedBeyondThresholdGauge.set(stats.reservedBeyondThreshold);
  metrics.outboxDeadWithReservedPayoutGauge.set(stats.outboxDeadWithReservedPayout);
}
