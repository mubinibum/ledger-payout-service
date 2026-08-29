/**
 * Minimal in-process metrics. Not a monitoring system — just labelled counters with a
 * snapshot for tests and a future `/metrics` endpoint (M5). No external dependency.
 */
class Counter {
  private readonly values = new Map<string, number>();

  constructor(readonly name: string) {}

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Record<string, string> = {}): number {
    return this.values.get(this.key(labels)) ?? 0;
  }

  private key(labels: Record<string, string>): string {
    const parts = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
    return parts.map(([k, v]) => `${k}=${v}`).join(',');
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  reset(): void {
    this.values.clear();
  }
}

export const metrics = {
  transfersTotal: new Counter('transfers_total'),
  transfersFailedTotal: new Counter('transfers_failed_total'),
  fundingTotal: new Counter('funding_total'),
  idempotencyReplayTotal: new Counter('idempotency_replay_total'),
  idempotencyConflictTotal: new Counter('idempotency_conflict_total'),
  transferRetryTotal: new Counter('transfer_retry_total'),

  snapshot(): Record<string, Record<string, number>> {
    return {
      transfers_total: this.transfersTotal.snapshot(),
      transfers_failed_total: this.transfersFailedTotal.snapshot(),
      funding_total: this.fundingTotal.snapshot(),
      idempotency_replay_total: this.idempotencyReplayTotal.snapshot(),
      idempotency_conflict_total: this.idempotencyConflictTotal.snapshot(),
      transfer_retry_total: this.transferRetryTotal.snapshot(),
    };
  },

  /** Test-only: zero every counter. */
  reset(): void {
    for (const value of Object.values(this)) {
      if (value instanceof Counter) value.reset();
    }
  },
};
