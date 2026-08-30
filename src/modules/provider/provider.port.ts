import type { ProviderCapabilities, ProviderResult } from '../../domain/provider-outcome.js';

/**
 * The port the payout worker and reconciliation depend on. `mock` is the only adapter in
 * M3 (`src/modules/provider/mock-provider.client.ts`); a real adapter is out of scope.
 *
 * Implementations MUST be idempotent on `idempotencyKey` — a retried `createPayout` with
 * the same key must not create a second provider-side payout — and MUST declare their
 * `capabilities()` conservatively (see `CONSERVATIVE_CAPABILITIES`). The payout policy
 * (ADR 0018) uses those capabilities to decide whether an outcome is definitive enough to
 * release reserved funds.
 */
export interface CreatePayoutRequest {
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
}

export interface ProviderPort {
  /** Submit a payout. Idempotent on `idempotencyKey`. May resolve async (`accepted`). */
  createPayout(req: CreatePayoutRequest): Promise<ProviderResult>;

  /** Look up a payout the provider previously accepted, by our idempotency key. */
  getPayoutStatus(idempotencyKey: string): Promise<ProviderResult>;

  /** What this adapter can contractually rely on. Drives the definitive-vs-ambiguous call. */
  capabilities(): ProviderCapabilities;
}
