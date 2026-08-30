import {
  CONSERVATIVE_CAPABILITIES,
  ProviderError,
  type FailureCategory,
  type ProviderCapabilities,
  type ProviderResult,
} from '../../src/domain/provider-outcome.js';
import type {
  CreatePayoutRequest,
  ProviderPort,
} from '../../src/modules/provider/provider.port.js';

type CreateBehavior =
  | { kind: 'succeeded' }
  | { kind: 'accepted' }
  | { kind: 'failed'; category?: FailureCategory }
  | { kind: 'transient'; times: number }
  | { kind: 'ambiguous' }
  | { kind: 'permanent'; category?: FailureCategory };

/**
 * In-process `ProviderPort` for fast, deterministic worker/reconciliation tests. Behaviour
 * is set per idempotency key; it records every call so tests can assert idempotency.
 */
export class FakeProvider implements ProviderPort {
  private readonly createBehavior = new Map<string, CreateBehavior>();
  private readonly statusResult = new Map<string, ProviderResult>();
  private readonly stored = new Map<string, string>(); // idempotencyKey -> providerPayoutId
  readonly createCalls: string[] = [];
  readonly statusCalls: string[] = [];
  private readonly attempts = new Map<string, number>();
  private caps: ProviderCapabilities = { ...CONSERVATIVE_CAPABILITIES };

  onCreate(idempotencyKey: string, behavior: CreateBehavior): void {
    this.createBehavior.set(idempotencyKey, behavior);
  }
  onStatus(idempotencyKey: string, result: ProviderResult): void {
    this.statusResult.set(idempotencyKey, result);
  }
  setCapabilities(caps: Partial<ProviderCapabilities>): void {
    this.caps = { ...this.caps, ...caps };
  }
  capabilities(): ProviderCapabilities {
    return this.caps;
  }

  async createPayout(req: CreatePayoutRequest): Promise<ProviderResult> {
    this.createCalls.push(req.idempotencyKey);
    const existing = this.stored.get(req.idempotencyKey);
    const behavior = this.createBehavior.get(req.idempotencyKey) ?? { kind: 'succeeded' };
    const n = (this.attempts.get(req.idempotencyKey) ?? 0) + 1;
    this.attempts.set(req.idempotencyKey, n);

    switch (behavior.kind) {
      case 'transient': {
        if (n <= behavior.times) throw new ProviderError('transient', 'temporary provider error');
        const id = existing ?? `fpp_${req.idempotencyKey}`;
        this.stored.set(req.idempotencyKey, id);
        return { kind: 'succeeded', providerPayoutId: id };
      }
      case 'permanent':
        throw new ProviderError(
          'permanent',
          'provider rejected',
          behavior.category ?? 'permanent_rejection',
        );
      case 'ambiguous':
        throw new ProviderError('ambiguous', 'provider connection reset');
      case 'failed': {
        const id = existing ?? `fpp_${req.idempotencyKey}`;
        this.stored.set(req.idempotencyKey, id);
        return {
          kind: 'failed',
          providerPayoutId: id,
          category: behavior.category ?? 'permanent_rejection',
        };
      }
      case 'accepted':
        return this.accept(req.idempotencyKey, existing);
      case 'succeeded': {
        const id = existing ?? `fpp_${req.idempotencyKey}`;
        this.stored.set(req.idempotencyKey, id);
        return { kind: 'succeeded', providerPayoutId: id };
      }
    }
  }

  private accept(key: string, existing: string | undefined): ProviderResult {
    const id = existing ?? `fpp_${key}`;
    this.stored.set(key, id);
    return { kind: 'accepted', providerPayoutId: id };
  }

  async getPayoutStatus(idempotencyKey: string): Promise<ProviderResult> {
    this.statusCalls.push(idempotencyKey);
    const explicit = this.statusResult.get(idempotencyKey);
    if (explicit) return explicit;
    const id = this.stored.get(idempotencyKey);
    if (!id) return { kind: 'unknown' };
    return { kind: 'pending', providerPayoutId: id };
  }

  createCallCount(idempotencyKey: string): number {
    return this.createCalls.filter((k) => k === idempotencyKey).length;
  }

  /** Clear all state between tests when the same instance is reused. */
  reset(): void {
    this.createBehavior.clear();
    this.statusResult.clear();
    this.stored.clear();
    this.attempts.clear();
    this.createCalls.length = 0;
    this.statusCalls.length = 0;
    this.caps = { ...CONSERVATIVE_CAPABILITIES };
  }
}
