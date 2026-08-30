import type { Transaction } from 'kysely';
import type { Database, DefinitiveOutcomeSource } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { PayoutNotFoundError } from '../../domain/errors.js';
import type { FailureCategory } from '../../domain/provider-outcome.js';
import {
  assertTransition,
  isTerminal,
  type ManualReviewReason,
  type PayoutStatus,
} from '../../domain/payout-state.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import {
  lockAccounts,
  findSystemAccount,
  type AccountRow,
} from '../accounts/accounts.repository.js';
import { postBalancedTransfer } from '../ledger/ledger.service.js';
import { lockPayout, updatePayout, type PayoutRow } from './payouts.repository.js';

/**
 * The single set of payout state transitions, each operating **within a caller-supplied
 * transaction**. Routes, the worker, the webhook handler, reconciliation and the
 * manual-review flow all go through these — the state machine and the ledger accounting
 * live in exactly one place.
 *
 * Every transition:
 *   1. locks the payout row `FOR UPDATE` first (global lock order: payout row, then
 *      accounts in ascending id order → no deadlock),
 *   2. is idempotent — re-applying a settled/released payout is a no-op,
 *   3. respects terminal-wins — a released payout is never settled and vice versa,
 *   4. never triggers an automatic release for an ambiguous outcome (ADR 0018).
 */
export type TransitionSource = 'worker' | 'webhook' | 'reconciliation' | 'api' | 'manual';

export interface SettleReleaseResult {
  payout: PayoutRow;
  /** 'applied' when this call did the work, 'noop' when it was already done, */
  /** 'conflict' when the payout was already terminal in the OPPOSITE direction. */
  effect: 'applied' | 'noop' | 'conflict';
}

async function mustLock(trx: Transaction<Database>, id: string): Promise<PayoutRow> {
  const row = await lockPayout(trx, id);
  if (!row) throw new PayoutNotFoundError(id);
  return row;
}

async function lockPair(
  trx: Transaction<Database>,
  idA: string,
  idB: string,
): Promise<[AccountRow, AccountRow]> {
  const rows = await lockAccounts(trx, [idA, idB].sort());
  const a = rows.find((r) => r.id === idA);
  const b = rows.find((r) => r.id === idB);
  if (!a || !b) throw new PayoutNotFoundError(idA); // system account missing → treat as not found
  return [a, b];
}

async function systemAccount(
  trx: Transaction<Database>,
  purpose: 'payout_holding' | 'provider_clearing',
  currency: string,
): Promise<AccountRow> {
  const row = await findSystemAccount(trx, purpose, currency);
  if (!row) throw new PayoutNotFoundError(`system:${purpose}:${currency}`);
  return row;
}

export async function markQueuedWithin(
  trx: Transaction<Database>,
  payoutId: string,
): Promise<void> {
  const payout = await lockPayout(trx, payoutId);
  if (!payout || payout.status !== 'requested') return;
  await updatePayout(trx, payoutId, { status: 'queued' });
  metrics.payoutTransitionsTotal.inc({ from: 'requested', to: 'queued' });
}

export async function markProcessingWithin(
  trx: Transaction<Database>,
  payoutId: string,
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  if (payout.status === 'processing') return payout;
  assertTransition(payout.status, 'processing');
  const updated = await updatePayout(trx, payoutId, {
    status: 'processing',
    incrementAttempt: true,
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'processing' });
  return updated;
}

export async function markRetryingWithin(
  trx: Transaction<Database>,
  payoutId: string,
): Promise<void> {
  const payout = await mustLock(trx, payoutId);
  if (payout.status === 'queued' || payout.status === 'submitted' || isTerminal(payout.status)) {
    return;
  }
  if (payout.status === 'manual_review') return;
  assertTransition(payout.status, 'queued');
  await updatePayout(trx, payoutId, { status: 'queued' });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'queued' });
}

/**
 * The provider acknowledged the request OR the outcome was ambiguous. Sets
 * `provider_contact = true` — from here on, an automatic release is not allowed.
 */
export async function markSubmittedWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: { providerPayoutId?: string | null; ambiguous?: boolean },
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  if (payout.status === 'submitted' || isTerminal(payout.status)) return payout;
  if (payout.status === 'manual_review') return payout;
  assertTransition(payout.status, 'submitted');
  const updated = await updatePayout(trx, payoutId, {
    status: 'submitted',
    submittedAt: 'now',
    providerContact: true,
    providerPayoutId: opts.providerPayoutId ?? null,
    nextReconcileAt: new Date(Date.now() + loadEnv().RECONCILE_STALE_AFTER_SEC * 1000),
    failureCategory: opts.ambiguous ? 'ambiguous_unresolved' : null,
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'submitted' });
  return updated;
}

/**
 * Route a payout to `manual_review`: non-terminal, funds stay reserved, automatic
 * processing stops. Idempotent; a no-op for a payout that is already terminal or already
 * has an accounting effect.
 */
export async function markManualReviewWithin(
  trx: Transaction<Database>,
  payoutId: string,
  reason: ManualReviewReason,
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  if (payout.status === 'manual_review') return payout;
  if (isTerminal(payout.status)) return payout;
  if (payout.settlement_ledger_transaction_id || payout.release_ledger_transaction_id) {
    return payout;
  }
  assertTransition(payout.status, 'manual_review');
  const updated = await updatePayout(trx, payoutId, {
    status: 'manual_review',
    manualReviewReason: reason,
    manualReviewAt: 'now',
    providerContact: true,
    nextReconcileAt: null,
    failureCategory: 'ambiguous_unresolved',
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'manual_review' });
  metrics.payoutManualReviewEnteredTotal.inc({ reason });
  logger.warn({ payoutId, reason, from: payout.status }, 'payout_manual_review_entered');
  return updated;
}

export async function settlePayoutWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: {
    providerPayoutId?: string | null;
    source: TransitionSource;
    definitiveSource?: DefinitiveOutcomeSource;
  },
): Promise<SettleReleaseResult> {
  const payout = await mustLock(trx, payoutId);
  if (payout.settlement_ledger_transaction_id) return { payout, effect: 'noop' };
  if (payout.release_ledger_transaction_id) {
    logConflict(payoutId, payout.status, 'succeeded');
    return { payout, effect: 'conflict' };
  }
  assertTransition(payout.status, 'succeeded');

  const currency = payout.currency.trim();
  const holdingRef = await systemAccount(trx, 'payout_holding', currency);
  const clearingRef = await systemAccount(trx, 'provider_clearing', currency);
  const [holding, clearing] = await lockPair(trx, holdingRef.id, clearingRef.id);

  const settlement = await postBalancedTransfer(trx, {
    type: 'payout_settlement',
    reference: `payout:${payout.external_id}`,
    metadata: { kind: 'payout_settlement', payoutId, source: opts.source },
    amountMinor: payout.amount_minor,
    currency,
    debitAccount: holding,
    creditAccount: clearing,
  });

  const updated = await updatePayout(trx, payoutId, {
    status: 'succeeded',
    settlementLedgerTransactionId: settlement.transactionId,
    completedAt: 'now',
    failureCategory: null,
    nextReconcileAt: null,
    manualReviewReason: null,
    definitiveOutcomeSource: opts.definitiveSource ?? 'worker',
    ...(opts.providerPayoutId ? { providerPayoutId: opts.providerPayoutId } : {}),
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'succeeded' });
  metrics.payoutSettlementsTotal.inc({ source: opts.source });
  return { payout: updated, effect: 'applied' };
}

export async function releasePayoutWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: {
    category: FailureCategory;
    source: TransitionSource;
    terminalStatus?: PayoutStatus;
    definitiveSource?: DefinitiveOutcomeSource;
  },
): Promise<SettleReleaseResult> {
  const terminal: PayoutStatus = opts.terminalStatus ?? 'failed';
  const payout = await mustLock(trx, payoutId);
  if (payout.release_ledger_transaction_id) return { payout, effect: 'noop' };
  if (payout.settlement_ledger_transaction_id) {
    logConflict(payoutId, payout.status, terminal);
    return { payout, effect: 'conflict' };
  }
  assertTransition(payout.status, terminal);

  const currency = payout.currency.trim();
  const holdingRef = await systemAccount(trx, 'payout_holding', currency);
  const [holding, source] = await lockPair(trx, holdingRef.id, payout.source_account_id);

  const release = await postBalancedTransfer(trx, {
    type: 'payout_release',
    reference: `payout:${payout.external_id}`,
    metadata: { kind: 'payout_release', payoutId, category: opts.category, source: opts.source },
    amountMinor: payout.amount_minor,
    currency,
    debitAccount: holding,
    creditAccount: source,
  });

  const updated = await updatePayout(trx, payoutId, {
    status: terminal,
    releaseLedgerTransactionId: release.transactionId,
    failureCategory: opts.category,
    completedAt: 'now',
    nextReconcileAt: null,
    manualReviewReason: null,
    definitiveOutcomeSource: opts.definitiveSource ?? 'worker',
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: terminal });
  metrics.payoutReleasesTotal.inc({ source: opts.source, category: opts.category });
  return { payout: updated, effect: 'applied' };
}

export async function rescheduleReconcileWithin(
  trx: Transaction<Database>,
  payoutId: string,
  lastOutcome?: string,
): Promise<void> {
  const payout = await mustLock(trx, payoutId);
  if (isTerminal(payout.status) || payout.status === 'manual_review') return;
  await updatePayout(trx, payoutId, {
    incrementReconcileAttempt: true,
    nextReconcileAt: new Date(Date.now() + loadEnv().RECONCILE_STALE_AFTER_SEC * 1000),
    ...(lastOutcome ? { lastReconciliationOutcome: lastOutcome } : {}),
  });
}

/** operator-driven: manual_review → submitted, fresh reconciliation budget. */
export async function resumeReconcileWithin(
  trx: Transaction<Database>,
  payoutId: string,
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  assertTransition(payout.status, 'submitted');
  const updated = await updatePayout(trx, payoutId, {
    status: 'submitted',
    resetReconcileAttempt: true,
    manualReviewReason: null,
    nextReconcileAt: new Date(Date.now() + loadEnv().RECONCILE_STALE_AFTER_SEC * 1000),
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'submitted' });
  return updated;
}

function logConflict(payoutId: string, currentStatus: PayoutStatus, attempted: PayoutStatus): void {
  metrics.payoutOutcomeConflictsTotal.inc({ current: currentStatus, attempted });
  logger.error(
    { payoutId, currentStatus, attemptedOutcome: attempted },
    'payout_outcome_conflict — a contradictory terminal outcome was received and ignored',
  );
}
