/**
 * How a payout provider interaction is interpreted. The worker and reconciliation map raw
 * provider responses / errors onto these; the payout policy (ADR 0018) decides what each
 * means for the ledger.
 *
 * The guiding rule: an outcome may trigger an automatic RELEASE only if it is either a
 * DEFINITIVE provider rejection or provably reached the provider not at all. Everything
 * else is AMBIGUOUS and must keep the funds reserved.
 */

/** A definite response from the provider (from `createPayout` or `getPayoutStatus`). */
export type ProviderResult =
  | { kind: 'accepted'; providerPayoutId: string } // async; wait for webhook / reconciliation
  | { kind: 'succeeded'; providerPayoutId: string } // DEFINITIVE success
  | { kind: 'failed'; providerPayoutId: string | null; category: FailureCategory } // DEFINITIVE failure
  | { kind: 'pending'; providerPayoutId: string | null } // still processing (reconciliation)
  | { kind: 'unknown' }; // provider has no record — ambiguity depends on `notFoundIsDefinitive`

/** Sanitised, non-sensitive failure buckets stored on the payout and logged. */
export type FailureCategory =
  | 'permanent_rejection' // definitive provider rejection (validation / policy)
  | 'transient_exhausted' // every attempt provably never reached the provider
  | 'ambiguous_unresolved' // marker on `submitted` payouts awaiting resolution
  | 'definitive_not_found' // provider contractually guarantees the request was never accepted
  | 'cancelled_before_submission' // user cancel, no provider submission
  | 'manual_resolution'; // released by an operator via the manual-review flow

/**
 * How a thrown error from a provider call is classified.
 *  - `transient`  — provably never reached the provider (safe to retry; safe to release if
 *                   every attempt was transient)
 *  - `permanent`  — a definitive rejection (safe to release)
 *  - `ambiguous`  — MAY have reached the provider (NEVER release; reconcile → manual_review)
 */
export type ProviderErrorClass = 'transient' | 'permanent' | 'ambiguous';

export class ProviderError extends Error {
  constructor(
    readonly classification: ProviderErrorClass,
    message: string,
    readonly providerCategory?: FailureCategory,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The contract this provider adapter can rely on. Defaults are CONSERVATIVE — a real
 * adapter opts in to stronger guarantees only when the provider's documentation backs them.
 */
export interface ProviderCapabilities {
  /** A `not_found` from the status lookup contractually means the request was never accepted. */
  notFoundIsDefinitive: boolean;
  /** An HTTP 5xx contractually means the request was NOT processed. */
  fivexxIsDefinitiveNonProcessing: boolean;
  /** `createPayout` / `getPayoutStatus` are idempotent on our stable idempotency key. */
  supportsRequestIdempotency: boolean;
  /** The status lookup is keyed by our idempotency key (vs a provider-assigned id only). */
  lookupUsesIdempotencyKey: boolean;
}

export const CONSERVATIVE_CAPABILITIES: ProviderCapabilities = {
  notFoundIsDefinitive: false,
  fivexxIsDefinitiveNonProcessing: false,
  supportsRequestIdempotency: true,
  lookupUsesIdempotencyKey: true,
};

/**
 * Classify a low-level failure from an HTTP provider call.
 *  - connection refused / DNS before send → transient (request never landed)
 *  - timeout / reset mid-flight            → ambiguous (the provider may have received it)
 *  - ANYTHING ELSE / unknown               → ambiguous (never guess in the caller's favour)
 */
export function classifyTransportError(err: unknown): ProviderErrorClass {
  if (err instanceof ProviderError) return err.classification;
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const name =
    typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;

  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'transient';
  }
  // Timeouts, resets, and every unrecognised error are treated as ambiguous.
  void name;
  return 'ambiguous';
}
