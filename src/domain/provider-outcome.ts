/**
 * How a payout provider interaction is interpreted. The worker and reconciliation both
 * map raw provider responses / errors onto these, and the payout policy decides what each
 * means for the ledger.
 */

/** A definite response from the provider. */
export type ProviderResult =
  | { kind: 'accepted'; providerPayoutId: string } // async; wait for webhook / reconciliation
  | { kind: 'succeeded'; providerPayoutId: string }
  | { kind: 'failed'; providerPayoutId: string | null; category: FailureCategory }
  | { kind: 'pending'; providerPayoutId: string | null } // still processing (reconciliation)
  | { kind: 'unknown' }; // provider has no record of this payout

/** Sanitised, non-sensitive failure buckets stored on the payout and logged. */
export type FailureCategory =
  | 'permanent_rejection'
  | 'transient_exhausted'
  | 'ambiguous_unresolved'
  | 'reconciliation_not_found'
  | 'cancelled_before_submission';

/** How a thrown error from the provider call is classified. */
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
 * Classify a low-level failure from an HTTP provider call.
 *  - connection refused / DNS / reset before send → transient (request never landed)
 *  - timeout / reset mid-flight → ambiguous (the provider may have received it)
 *  - anything explicitly permanent is raised as ProviderError('permanent') by the adapter
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
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ECONNRESET'
  ) {
    return 'ambiguous';
  }
  return 'transient';
}
