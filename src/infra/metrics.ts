/**
 * Minimal in-process metrics — labelled counters and gauges with a `snapshot()` for tests
 * and a future `/metrics` endpoint (M5). No external dependency. Names use Prometheus
 * conventions (`_total` suffix on counters) so exposition later is a formatting step only.
 */
function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

class Counter {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string) {}

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  get(labels: Record<string, string> = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
  reset(): void {
    this.values.clear();
  }
}

class Gauge {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string) {}

  set(value: number, labels: Record<string, string> = {}): void {
    this.values.set(labelKey(labels), value);
  }
  get(labels: Record<string, string> = {}): number | undefined {
    return this.values.get(labelKey(labels));
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
  reset(): void {
    this.values.clear();
  }
}

const registry = {
  // M2
  transfersTotal: new Counter('transfers_total'),
  transfersFailedTotal: new Counter('transfers_failed_total'),
  fundingTotal: new Counter('funding_total'),
  idempotencyReplayTotal: new Counter('idempotency_replay_total'),
  idempotencyConflictTotal: new Counter('idempotency_conflict_total'),
  transferRetryTotal: new Counter('transfer_retry_total'),

  // M3 — payouts
  payoutsCreatedTotal: new Counter('payouts_created_total'),
  payoutsFailedTotal: new Counter('payouts_failed_total'), // labels: code
  payoutCancelledTotal: new Counter('payouts_cancelled_total'),
  payoutTransitionsTotal: new Counter('payout_transitions_total'), // labels: from,to
  payoutSettlementsTotal: new Counter('payout_settlements_total'), // labels: source
  payoutReleasesTotal: new Counter('payout_releases_total'), // labels: source,category

  // M3.1 — ambiguous-payout safety
  payoutManualReviewEnteredTotal: new Counter('payout_manual_review_entered_total'), // labels: reason
  payoutManualResolutionsTotal: new Counter('payout_manual_resolutions_total'), // labels: resolution,outcome
  payoutOutcomeConflictsTotal: new Counter('payout_outcome_conflicts_total'), // labels: current,attempted
  providerAmbiguousOutcomesTotal: new Counter('provider_ambiguous_outcomes_total'), // labels: source
  payoutManualReviewGauge: new Gauge('payout_manual_review'),
  payoutManualReviewOldestSecondsGauge: new Gauge('payout_manual_review_oldest_seconds'),
  payoutsReservedBeyondThresholdGauge: new Gauge('payouts_reserved_beyond_threshold'),
  outboxDeadWithReservedPayoutGauge: new Gauge('outbox_dead_with_reserved_payout'),

  // M3 — provider
  providerAttemptsTotal: new Counter('provider_attempts_total'), // labels: outcome
  providerErrorsTotal: new Counter('provider_errors_total'), // labels: classification

  // M3 — outbox
  outboxPublishedTotal: new Counter('outbox_published_total'), // labels: event_type
  outboxRetryTotal: new Counter('outbox_retry_total'), // labels: category
  outboxPendingGauge: new Gauge('outbox_pending'),
  outboxOldestPendingSecondsGauge: new Gauge('outbox_oldest_pending_seconds'),
  outboxDeadGauge: new Gauge('outbox_dead'),

  // M3 — worker
  workerJobsTotal: new Counter('worker_jobs_total'), // labels: result
  workerRetryTotal: new Counter('worker_retry_total'),
  workerDlqTotal: new Counter('worker_dlq_total'),

  // M3 — webhooks
  webhookAcceptedTotal: new Counter('webhook_accepted_total'), // labels: event_type
  webhookRejectedTotal: new Counter('webhook_rejected_total'), // labels: reason
  webhookReplayedTotal: new Counter('webhook_replayed_total'),

  // M3 — reconciliation
  reconciliationRunsTotal: new Counter('reconciliation_runs_total'),
  reconciliationOutcomesTotal: new Counter('reconciliation_outcomes_total'), // labels: outcome
};

type Registry = typeof registry;

export const metrics: Registry & {
  snapshot(): Record<string, Record<string, number>>;
  reset(): void;
} = Object.assign(registry, {
  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const value of Object.values(registry)) {
      if (value instanceof Counter || value instanceof Gauge) {
        out[value.name] = value.snapshot();
      }
    }
    return out;
  },
  /** Test-only: zero every counter and gauge. */
  reset(): void {
    for (const value of Object.values(registry)) {
      if (value instanceof Counter || value instanceof Gauge) value.reset();
    }
  },
});
