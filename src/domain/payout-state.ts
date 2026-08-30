import type { PayoutStatus } from '../db/schema.js';
import { DomainError } from './errors.js';

/**
 * Payout lifecycle.
 *
 *   requested  — created; funds reserved (source → holding); outbox event written
 *   queued     — outbox event published to the queue
 *   processing — a worker attempt is in flight
 *   submitted  — the provider acknowledged the request; the final result is still pending
 *                (confirmed later by a signed webhook or by reconciliation)
 *   succeeded  — terminal; settled (holding → provider clearing)
 *   failed     — terminal; released (holding → source)
 *   cancelled  — terminal; released; only reachable before the request reached the provider
 *
 * Terminal states never change again. Every transition goes through `assertTransition`,
 * which is the single source of truth (routes, worker, webhook, reconciliation all use it).
 */
export type { PayoutStatus };

export const PAYOUT_STATUSES = [
  'requested',
  'queued',
  'processing',
  'submitted',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly PayoutStatus[];

export const TERMINAL_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

/** Statuses from which a payout may still be cancelled (provider not yet involved). */
export const CANCELLABLE_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'requested',
  'queued',
]);

const ALLOWED: Record<PayoutStatus, ReadonlySet<PayoutStatus>> = {
  requested: new Set<PayoutStatus>(['queued', 'processing', 'cancelled', 'failed']),
  queued: new Set<PayoutStatus>(['processing', 'cancelled', 'failed']),
  // processing → queued models a transient retry going back to wait for the next attempt.
  processing: new Set<PayoutStatus>(['submitted', 'succeeded', 'failed', 'queued']),
  submitted: new Set<PayoutStatus>(['succeeded', 'failed']),
  succeeded: new Set<PayoutStatus>(),
  failed: new Set<PayoutStatus>(),
  cancelled: new Set<PayoutStatus>(),
};

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL_STATUSES.has(status);
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
