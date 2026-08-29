import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { AccountNotFoundError, NotFoundError } from '../../domain/errors.js';
import { requestFingerprint } from '../../domain/fingerprint.js';
import {
  applyCredit,
  applyDebit,
  assertActive,
  assertCurrency,
  assertDistinctAccounts,
  type AccountFacts,
} from '../../domain/transfer-rules.js';
import type { TransferInput, TransferView } from '../../domain/types.js';
import { metrics } from '../../infra/metrics.js';
import { runInTransaction } from '../../infra/tx.js';
import { lockAccounts, setAccountBalance } from '../accounts/accounts.repository.js';
import {
  findEntriesByTransactionId,
  findLedgerTransactionById,
  insertLedgerEntry,
  insertLedgerTransaction,
  toTransactionView,
} from '../ledger/ledger.repository.js';
import { beginIdempotent } from '../idempotency/idempotency.service.js';

export interface TransferResult {
  statusCode: number;
  body: TransferView | Record<string, unknown>;
}

export class TransfersService {
  constructor(private readonly db: Kysely<Database>) {}

  async createTransfer(input: TransferInput, idempotencyKey: string): Promise<TransferResult> {
    assertDistinctAccounts(input.sourceAccountId, input.destinationAccountId);

    const fingerprint = requestFingerprint('transfer', {
      source: input.sourceAccountId,
      destination: input.destinationAccountId,
      amount: input.amountMinor.toString(10),
      currency: input.currency,
      reference: input.reference,
      metadata: input.metadata,
    });

    const { TRANSFER_MAX_RETRIES } = loadEnv();

    return runInTransaction(this.db, { maxRetries: TRANSFER_MAX_RETRIES }, async (trx) => {
      // 1. Idempotency gate — before any row lock, so a same-key race serialises here.
      const gate = await beginIdempotent(trx, 'transfer', idempotencyKey, fingerprint);
      if (gate.kind === 'replay') {
        return { statusCode: gate.statusCode, body: gate.body };
      }

      // 2. Lock both accounts in one deterministic (ascending id) order → no deadlock.
      const orderedIds = [input.sourceAccountId, input.destinationAccountId].sort();
      const locked = await lockAccounts(trx, orderedIds);
      const source = locked.find((r) => r.id === input.sourceAccountId);
      const destination = locked.find((r) => r.id === input.destinationAccountId);

      if (!source) throw new AccountNotFoundError(input.sourceAccountId);
      if (!destination) throw new AccountNotFoundError(input.destinationAccountId);

      // 3. Validate against the freshly-locked state.
      const sourceFacts: AccountFacts = {
        id: source.id,
        status: source.status,
        currency: source.currency,
        allowOverdraft: source.allow_overdraft,
        balanceMinor: source.balance_minor,
      };
      const destinationFacts: AccountFacts = {
        id: destination.id,
        status: destination.status,
        currency: destination.currency,
        allowOverdraft: destination.allow_overdraft,
        balanceMinor: destination.balance_minor,
      };
      const currency = input.currency;
      assertActive(sourceFacts);
      assertActive(destinationFacts);
      assertCurrency(sourceFacts.currency, currency);
      assertCurrency(destinationFacts.currency, currency);

      const amount = input.amountMinor;
      const newSourceBalance = applyDebit(sourceFacts, amount);
      const newDestinationBalance = applyCredit(destinationFacts, amount);

      // 4. Ledger transaction + balanced entries + balance projection — one atomic unit.
      const txn = await insertLedgerTransaction(trx, {
        type: 'transfer',
        reference: input.reference,
        metadata: input.metadata,
      });
      await insertLedgerEntry(trx, {
        ledgerTransactionId: txn.id,
        accountId: source.id,
        direction: 'debit',
        amountMinor: amount,
        balanceAfterMinor: newSourceBalance,
        currency,
      });
      await insertLedgerEntry(trx, {
        ledgerTransactionId: txn.id,
        accountId: destination.id,
        direction: 'credit',
        amountMinor: amount,
        balanceAfterMinor: newDestinationBalance,
        currency,
      });
      await setAccountBalance(trx, source.id, newSourceBalance);
      await setAccountBalance(trx, destination.id, newDestinationBalance);

      const entries = await findEntriesByTransactionId(trx, txn.id);
      const view = toTransactionView(txn, entries);

      // 5. Persist the idempotency result in the SAME transaction as the ledger writes.
      await gate.finalize(txn.id, 201, view as unknown as Record<string, unknown>);
      metrics.transfersTotal.inc();

      return { statusCode: 201, body: view };
    });
  }

  async getTransfer(id: string): Promise<TransferView> {
    const txn = await findLedgerTransactionById(this.db, id);
    if (!txn || txn.type !== 'transfer') throw new NotFoundError('transfer');
    const entries = await findEntriesByTransactionId(this.db, id);
    return toTransactionView(txn, entries);
  }

  async getLedgerTransaction(id: string): Promise<TransferView> {
    const txn = await findLedgerTransactionById(this.db, id);
    if (!txn) throw new NotFoundError('ledger transaction');
    const entries = await findEntriesByTransactionId(this.db, id);
    return toTransactionView(txn, entries);
  }
}
