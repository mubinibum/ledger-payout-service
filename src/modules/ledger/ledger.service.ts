import type { Transaction } from 'kysely';
import type { Database, LedgerTransactionType } from '../../db/schema.js';
import { InsufficientFundsError } from '../../domain/errors.js';
import type { AccountRow } from '../accounts/accounts.repository.js';
import { setAccountBalance } from '../accounts/accounts.repository.js';
import { insertLedgerEntry, insertLedgerTransaction } from './ledger.repository.js';

/**
 * Posts one balanced two-entry ledger transaction that moves `amountMinor` from
 * `debitAccount` (balance ↓) to `creditAccount` (balance ↑), and updates both cached
 * balance projections — all inside the caller's transaction, against rows the caller has
 * already locked `FOR UPDATE`.
 *
 * Sign convention (ADR 0005): credit increases a balance, debit decreases it. The M2
 * deferred trigger re-checks Σ = 0 and count ≥ 2 at COMMIT; this helper is what keeps the
 * service code from ever building an unbalanced pair in the first place.
 */
export interface PostBalancedInput {
  type: LedgerTransactionType;
  reference: string | null;
  metadata: Record<string, unknown>;
  amountMinor: bigint;
  currency: string;
  debitAccount: AccountRow;
  creditAccount: AccountRow;
}

export interface PostBalancedResult {
  transactionId: string;
  debitBalanceAfter: bigint;
  creditBalanceAfter: bigint;
}

export async function postBalancedTransfer(
  trx: Transaction<Database>,
  input: PostBalancedInput,
): Promise<PostBalancedResult> {
  const debitBalanceAfter = input.debitAccount.balance_minor - input.amountMinor;
  if (!input.debitAccount.allow_overdraft && debitBalanceAfter < 0n) {
    throw new InsufficientFundsError(input.debitAccount.id);
  }
  const creditBalanceAfter = input.creditAccount.balance_minor + input.amountMinor;

  const txn = await insertLedgerTransaction(trx, {
    type: input.type,
    reference: input.reference,
    metadata: input.metadata,
  });

  await insertLedgerEntry(trx, {
    ledgerTransactionId: txn.id,
    accountId: input.debitAccount.id,
    direction: 'debit',
    amountMinor: input.amountMinor,
    balanceAfterMinor: debitBalanceAfter,
    currency: input.currency,
  });
  await insertLedgerEntry(trx, {
    ledgerTransactionId: txn.id,
    accountId: input.creditAccount.id,
    direction: 'credit',
    amountMinor: input.amountMinor,
    balanceAfterMinor: creditBalanceAfter,
    currency: input.currency,
  });

  await setAccountBalance(trx, input.debitAccount.id, debitBalanceAfter);
  await setAccountBalance(trx, input.creditAccount.id, creditBalanceAfter);

  return { transactionId: txn.id, debitBalanceAfter, creditBalanceAfter };
}
