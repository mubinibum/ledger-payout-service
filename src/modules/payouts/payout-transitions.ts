import type { Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { PayoutNotFoundError } from '../../domain/errors.js';
import type { FailureCategory } from '../../domain/provider-outcome.js';
import { assertTransition, isTerminal, type PayoutStatus } from '../../domain/payout-state.js';
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
 * transaction**. Routes, the worker, the webhook handler and reconciliation all go through
 * these — the state machine and the ledger accounting live in exactly one place.
 *
 * Every transition:
 *   1. locks the payout row `FOR UPDATE` first (global lock order: payout row, then
 *      accounts in ascending id order → no deadlock),
 *   2. is idempotent — re-applying a settled/released payout is a no-op,
 *   3. respects terminal-wins — a released payout is never settled and vice versa.
 */
export type TransitionSource = 'worker' | 'webhook' | 'reconciliation' | 'api';

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
  assertTransition(payout.status, 'queued');
  await updatePayout(trx, payoutId, { status: 'queued' });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'queued' });
}

export async function markSubmittedWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: { providerPayoutId?: string | null; ambiguous?: boolean },
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  if (payout.status === 'submitted' || isTerminal(payout.status)) return payout;
  assertTransition(payout.status, 'submitted');
  const updated = await updatePayout(trx, payoutId, {
    status: 'submitted',
    submittedAt: 'now',
    providerPayoutId: opts.providerPayoutId ?? null,
    nextReconcileAt: new Date(Date.now() + loadEnv().RECONCILE_STALE_AFTER_SEC * 1000),
    failureCategory: opts.ambiguous ? 'ambiguous_unresolved' : null,
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'submitted' });
  return updated;
}

export async function settlePayoutWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: { providerPayoutId?: string | null; source: TransitionSource },
): Promise<PayoutRow> {
  const payout = await mustLock(trx, payoutId);
  if (payout.settlement_ledger_transaction_id) return payout; // already settled
  if (payout.release_ledger_transaction_id) return payout; // released: terminal wins
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
    ...(opts.providerPayoutId ? { providerPayoutId: opts.providerPayoutId } : {}),
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: 'succeeded' });
  metrics.payoutSettlementsTotal.inc({ source: opts.source });
  return updated;
}

export async function releasePayoutWithin(
  trx: Transaction<Database>,
  payoutId: string,
  opts: { category: FailureCategory; source: TransitionSource; terminalStatus?: PayoutStatus },
): Promise<PayoutRow> {
  const terminal: PayoutStatus = opts.terminalStatus ?? 'failed';
  const payout = await mustLock(trx, payoutId);
  if (payout.release_ledger_transaction_id) return payout; // already released
  if (payout.settlement_ledger_transaction_id) return payout; // settled: keep success
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
  });
  metrics.payoutTransitionsTotal.inc({ from: payout.status, to: terminal });
  metrics.payoutReleasesTotal.inc({ source: opts.source, category: opts.category });
  return updated;
}

export async function rescheduleReconcileWithin(
  trx: Transaction<Database>,
  payoutId: string,
): Promise<void> {
  const payout = await mustLock(trx, payoutId);
  if (isTerminal(payout.status)) return;
  await updatePayout(trx, payoutId, {
    incrementReconcileAttempt: true,
    nextReconcileAt: new Date(Date.now() + loadEnv().RECONCILE_STALE_AFTER_SEC * 1000),
  });
}
