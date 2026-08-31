/**
 * Minimal in-process metrics — labelled counters, gauges and histograms with a `snapshot()`
 * for tests and a Prometheus text exposition (`render()`) served by `GET /metrics` when
 * `METRICS_ENABLED=true` (see `src/modules/metrics`). No external dependency. Names follow
 * Prometheus conventions (`_total` on counters, base-unit seconds on histograms).
 *
 * LABEL SAFETY (M4): every label written here must be a bounded, low-cardinality value — an
 * HTTP method, a normalised route template (`/v1/accounts/:id`, never a real id), an enum
 * outcome/reason/code, a status class (`2xx`). Never a payout id, account id, idempotency
 * key, provider id, raw reference, URL with ids, or an error message. The `/metrics` route
 * test asserts this by scanning the exposition for uuid- and digit-run-shaped label values.
 */
type Labels = Record<string, string>;

// Unit separator — cannot occur in any label key/value we produce (all bounded enums,
// methods, status classes, route templates).
const SEP = String.fromCharCode(31);

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k] ?? ''}`).join(SEP);
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return '';
  const body = keys
    .map(
      (k) =>
        `${k}="${String(all[k] ?? '')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')}"`,
    )
    .join(',');
  return `{${body}}`;
}

abstract class Metric {
  protected readonly entries = new Map<string, { value: number; labels: Labels }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  get(labels: Labels = {}): number {
    return this.entries.get(labelKey(labels))?.value ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.entries.entries()].map(([k, e]) => [k.split(SEP).join(','), e.value]),
    );
  }
  reset(): void {
    this.entries.clear();
  }
  abstract render(): string;
  protected typeLine(type: string): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${type}`;
  }
}

class Counter extends Metric {
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const cur = this.entries.get(key);
    if (cur) cur.value += by;
    else this.entries.set(key, { value: by, labels });
  }
  render(): string {
    const lines = [this.typeLine('counter')];
    if (this.entries.size === 0) lines.push(`${this.name} 0`);
    for (const e of this.entries.values()) {
      lines.push(`${this.name}${renderLabels(e.labels)} ${e.value}`);
    }
    return lines.join('\n');
  }
}

class Gauge extends Metric {
  set(value: number, labels: Labels = {}): void {
    this.entries.set(labelKey(labels), { value, labels });
  }
  override get(labels: Labels = {}): number {
    return this.entries.get(labelKey(labels))?.value ?? 0;
  }
  render(): string {
    const lines = [this.typeLine('gauge')];
    if (this.entries.size === 0) lines.push(`${this.name} 0`);
    for (const e of this.entries.values()) {
      lines.push(`${this.name}${renderLabels(e.labels)} ${e.value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) s.counts[i] = (s.counts[i] as number) + 1;
    }
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.series.entries()].map(([k, s]) => [k.split(SEP).join(','), s.count]),
    );
  }
  reset(): void {
    this.series.clear();
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(s.labels, { le: String(this.buckets[i]) })} ${s.counts[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

const registry = {
  // M4 — HTTP surface
  httpRequestsTotal: new Counter(
    'http_requests_total',
    'HTTP requests by method, route template and status class.',
  ),
  httpRequestDurationSeconds: new Histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds by method and route template.',
  ),

  // M2
  transfersTotal: new Counter('transfers_total', 'Internal transfers committed.'),
  transfersFailedTotal: new Counter(
    'transfers_failed_total',
    'Internal transfers rejected, by domain error code.',
  ),
  fundingTotal: new Counter('funding_total', 'Dev/demo funding operations applied.'),
  idempotencyReplayTotal: new Counter(
    'idempotency_replay_total',
    'Requests served from a stored idempotent response.',
  ),
  idempotencyConflictTotal: new Counter(
    'idempotency_conflict_total',
    'Idempotency-Key reused with a different request payload.',
  ),
  transferRetryTotal: new Counter(
    'transfer_retry_total',
    'Transfer attempts retried after a transient DB error.',
  ),

  // M3 — payouts
  payoutsCreatedTotal: new Counter('payouts_created_total', 'Payouts created (funds reserved).'),
  payoutsFailedTotal: new Counter('payouts_failed_total', 'Payout creations rejected, by code.'),
  payoutCancelledTotal: new Counter(
    'payouts_cancelled_total',
    'Payouts cancelled before provider submission.',
  ),
  payoutTransitionsTotal: new Counter(
    'payout_transitions_total',
    'Payout state transitions, by from/to state.',
  ),
  payoutSettlementsTotal: new Counter(
    'payout_settlements_total',
    'Payout reservations settled to provider clearing, by trigger source.',
  ),
  payoutReleasesTotal: new Counter(
    'payout_releases_total',
    'Payout reservations released back to source, by source and category.',
  ),

  // M3.1 — ambiguous-payout safety
  payoutManualReviewEnteredTotal: new Counter(
    'payout_manual_review_entered_total',
    'Payouts moved to manual_review, by reason.',
  ),
  payoutManualResolutionsTotal: new Counter(
    'payout_manual_resolutions_total',
    'Operator resolutions of manual_review payouts, by resolution and outcome.',
  ),
  payoutOutcomeConflictsTotal: new Counter(
    'payout_outcome_conflicts_total',
    'Contradictory terminal outcomes ignored, by current/attempted state.',
  ),
  providerAmbiguousOutcomesTotal: new Counter(
    'provider_ambiguous_outcomes_total',
    'Provider interactions that ended ambiguously, by source.',
  ),
  payoutManualReviewGauge: new Gauge(
    'payout_manual_review',
    'Payouts currently awaiting manual review.',
  ),
  payoutManualReviewOldestSecondsGauge: new Gauge(
    'payout_manual_review_oldest_seconds',
    'Age of the oldest payout in manual_review, in seconds.',
  ),
  payoutsReservedBeyondThresholdGauge: new Gauge(
    'payouts_reserved_beyond_threshold',
    'Payouts still holding reserved funds past RESERVED_PAYOUT_ALERT_SEC.',
  ),
  outboxDeadWithReservedPayoutGauge: new Gauge(
    'outbox_dead_with_reserved_payout',
    'Dead outbox events whose payout still holds reserved funds.',
  ),

  // M3 — provider
  providerAttemptsTotal: new Counter(
    'provider_attempts_total',
    'Provider submission attempts, by outcome.',
  ),
  providerErrorsTotal: new Counter(
    'provider_errors_total',
    'Provider transport errors, by classification.',
  ),

  // M3 — outbox
  outboxPublishedTotal: new Counter(
    'outbox_published_total',
    'Outbox events published to the queue, by event type.',
  ),
  outboxRetryTotal: new Counter('outbox_retry_total', 'Outbox publish retries, by category.'),
  outboxPendingGauge: new Gauge('outbox_pending', 'Outbox events awaiting publication.'),
  outboxOldestPendingSecondsGauge: new Gauge(
    'outbox_oldest_pending_seconds',
    'Age of the oldest unpublished outbox event, in seconds.',
  ),
  outboxDeadGauge: new Gauge('outbox_dead', 'Outbox events that exhausted publish attempts.'),

  // M3 — worker
  workerJobsTotal: new Counter('worker_jobs_total', 'Worker job executions, by result.'),
  workerRetryTotal: new Counter('worker_retry_total', 'Worker job attempts that were retried.'),
  workerDlqTotal: new Counter('worker_dlq_total', 'Worker jobs moved to the dead-letter queue.'),

  // M3 — webhooks
  webhookAcceptedTotal: new Counter(
    'webhook_accepted_total',
    'Inbound provider webhooks accepted, by event type.',
  ),
  webhookRejectedTotal: new Counter(
    'webhook_rejected_total',
    'Inbound provider webhooks rejected, by reason.',
  ),
  webhookReplayedTotal: new Counter(
    'webhook_replayed_total',
    'Inbound provider webhooks recognised as replays.',
  ),

  // M3 — reconciliation
  reconciliationRunsTotal: new Counter('reconciliation_runs_total', 'Reconciliation passes run.'),
  reconciliationOutcomesTotal: new Counter(
    'reconciliation_outcomes_total',
    'Reconciliation results, by outcome.',
  ),
};

type Registry = typeof registry;
const members = (): (Counter | Gauge | Histogram)[] =>
  Object.values(registry).filter(
    (v): v is Counter | Gauge | Histogram =>
      v instanceof Counter || v instanceof Gauge || v instanceof Histogram,
  );

export const metrics: Registry & {
  snapshot(): Record<string, Record<string, number>>;
  reset(): void;
  render(): string;
} = Object.assign(registry, {
  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const m of members()) out[m.name] = m.snapshot();
    return out;
  },
  /** Test-only: zero every counter, gauge and histogram. */
  reset(): void {
    for (const m of members()) m.reset();
  },
  /** Prometheus text exposition (format version 0.0.4). */
  render(): string {
    return members()
      .map((m) => m.render())
      .join('\n\n')
      .concat('\n');
  },
});
