import type { PayoutStatus } from '../db/schema.js';
import { DomainError } from './errors.js';

/**
 * Payout lifecycle.
 *
 *   requested     — created; funds reserved (source → holding); outbox event written
 *   queued        — outbox event published to the queue
 *   processing    — a worker attempt is in flight
 *   submitted     — the provider acknowledged the request OR the outcome was ambiguous;
 *                   the final result is still pending (confirmed later by a signed webhook
 *                   or by reconciliation). FUNDS STAY RESERVED.
 *   manual_review — the outcome could not be resolved automatically and the request may
 *                   have reached the provider. Non-success, non-failure. FUNDS STAY
 *                   RESERVED. Automatic processing stops. Not cancellable via the public
 *                   API. Not terminal for accounting. Only an explicit internal resolution
 *                   moves it out (see `manual-review.service.ts`).
 *   succeeded     — terminal; settled (holding → provider clearing)
 *   failed        — terminal; released (holding → source)
 *   cancelled     — terminal; released; only reachable before any provider submission
 *
 * SAFETY RULE (ADR 0018): reserved funds are released automatically only after a
 * definitive, contractually-reliable provider rejection, or a user cancellation before any
 * provider submission attempt. Never on a timeout, a retry/attempt budget being spent, a
 * missing webhook, an unknown/not_found status, or a DLQ. Anything ambiguous ends up in
 * `manual_review`.
 *
 * Every transition goes through `assertTransition`, the single source of truth (routes,
 * worker, webhook, reconciliation, manual resolution all use it).
 */
export type { PayoutStatus };

export const PAYOUT_STATUSES = [
  'requested',
  'queued',
  'processing',
  'submitted',
  'manual_review',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly PayoutStatus[];

export const TERMINAL_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

/** Statuses from which a payout may still be cancelled (no provider submission yet). */
export const CANCELLABLE_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'requested',
  'queued',
]);

/** Non-terminal statuses that hold reserved funds and receive no automatic processing. */
export const NEEDS_OPERATOR_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'manual_review',
]);

const ALLOWED: Record<PayoutStatus, ReadonlySet<PayoutStatus>> = {
  requested: new Set<PayoutStatus>([
    'queued',
    'processing',
    'cancelled',
    'failed',
    'manual_review',
  ]),
  queued: new Set<PayoutStatus>(['processing', 'cancelled', 'failed', 'manual_review']),
  // processing → queued models a transient (proven-not-reached) retry going back to wait.
  processing: new Set<PayoutStatus>([
    'submitted',
    'succeeded',
    'failed',
    'queued',
    'manual_review',
  ]),
  submitted: new Set<PayoutStatus>(['succeeded', 'failed', 'manual_review']),
  // manual_review is only left by an explicit internal resolution.
  manual_review: new Set<PayoutStatus>(['succeeded', 'failed', 'submitted']),
  succeeded: new Set<PayoutStatus>(),
  failed: new Set<PayoutStatus>(),
  cancelled: new Set<PayoutStatus>(),
};

/** Why a payout entered manual review — sanitised, non-sensitive. */
export type ManualReviewReason =
  | 'reconciliation_exhausted'
  | 'ambiguous_unresolved'
  | 'dlq_provider_contact_possible'
  | 'provider_outcome_conflict'
  | 'malformed_provider_status'
  | 'worker_unexpected_error'
  | 'operator_flagged';

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isManualReview(status: PayoutStatus): status is 'manual_review' {
  return status === 'manual_review';
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  if (from === to) return true; // idempotent re-apply is always allowed (callers no-op)
  return ALLOWED[from].has(to);
}

export class InvalidPayoutTransitionError extends DomainError {
  constructor(from: PayoutStatus, to: PayoutStatus) {
    super('invalid_payout_transition', 409, `payout cannot move from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidPayoutTransitionError(from, to);
  }
}
