import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import {
  AccountNotActiveError,
  AccountNotFoundError,
  CurrencyMismatchError,
  FundingDisabledError,
  UnsupportedCurrencyError,
  ValidationError,
} from '../../domain/errors.js';
import type {
  Account,
  CreateAccountInput,
  FundAccountInput,
  LedgerEntryView,
  LedgerTransactionView,
  Page,
} from '../../domain/types.js';
import { runInTransaction } from '../../infra/tx.js';
import { metrics } from '../../infra/metrics.js';
import {
  findAccountByExternalId,
  findAccountById,
  findSystemAccount,
  insertAccount,
  listLedgerEntries,
  lockAccounts,
  setAccountBalance,
  toAccount,
} from './accounts.repository.js';
import {
  findEntriesByTransactionId,
  insertLedgerEntry,
  insertLedgerTransaction,
  toTransactionView,
} from '../ledger/ledger.repository.js';
import { beginIdempotent } from '../idempotency/idempotency.service.js';
import { requestFingerprint } from '../../domain/fingerprint.js';

export class AccountsService {
  constructor(private readonly db: Kysely<Database>) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const existing = await findAccountByExternalId(this.db, input.externalId);
    if (existing) {
      throw new ValidationError('externalId is already in use', { externalId: input.externalId });
    }
    const row = await insertAccount(this.db, {
      external_id: input.externalId,
      currency: input.currency,
      allow_overdraft: input.allowOverdraft,
    });
    return toAccount(row);
  }

  async getAccount(id: string): Promise<Account> {
    const row = await findAccountById(this.db, id);
    if (!row) throw new AccountNotFoundError(id);
    return toAccount(row);
  }

  async getLedgerHistory(
    id: string,
    opts: { limit: number; cursor?: string },
  ): Promise<Page<LedgerEntryView>> {
    const row = await findAccountById(this.db, id);
    if (!row) throw new AccountNotFoundError(id);
    return listLedgerEntries(this.db, id, opts);
  }

  /**
   * Dev/test opening balance. Injects value via a balanced ledger transaction:
   * credit the target account, debit the matching internal system account (which is the
   * only account permitted to run negative). Never writes a balance directly.
   */
  async fund(
    input: FundAccountInput,
    idempotencyKey: string,
  ): Promise<{ statusCode: number; body: LedgerTransactionView | Record<string, unknown> }> {
    const env = loadEnv();
    if (!env.ALLOW_FUNDING) throw new FundingDisabledError();

    const fingerprint = requestFingerprint('funding', {
      accountId: input.accountId,
      amount: input.amountMinor.toString(10),
      currency: input.currency,
      reference: input.reference,
    });

    const outcome = await runInTransaction(
      this.db,
      { maxRetries: env.TRANSFER_MAX_RETRIES },
      async (trx) => {
        const gate = await beginIdempotent(trx, 'funding', idempotencyKey, fingerprint);
        if (gate.kind === 'replay') {
          return { statusCode: gate.statusCode, body: gate.body };
        }

        const target = await findAccountById(trx, input.accountId);
        if (!target) throw new AccountNotFoundError(input.accountId);
        if (target.status !== 'active') {
          throw new AccountNotActiveError(target.id, target.status);
        }
        if (target.currency.trim() !== input.currency) {
          throw new CurrencyMismatchError(target.currency.trim(), input.currency);
        }

        const system = await findSystemAccount(trx, 'funding', input.currency);
        if (!system) throw new UnsupportedCurrencyError(input.currency);

        // Lock both rows in a single deterministic order.
        const ids = [target.id, system.id].sort();
        const locked = await lockAccounts(trx, ids);
        const lockedTarget = locked.find((r) => r.id === target.id);
        const lockedSystem = locked.find((r) => r.id === system.id);
        if (!lockedTarget || !lockedSystem) throw new AccountNotFoundError(input.accountId);

        const amount = input.amountMinor;
        const newTargetBalance = lockedTarget.balance_minor + amount;
        const newSystemBalance = lockedSystem.balance_minor - amount;

        const txn = await insertLedgerTransaction(trx, {
          type: 'funding',
          reference: input.reference,
          metadata: {},
        });
        await insertLedgerEntry(trx, {
          ledgerTransactionId: txn.id,
          accountId: lockedSystem.id,
          direction: 'debit',
          amountMinor: amount,
          balanceAfterMinor: newSystemBalance,
          currency: input.currency,
        });
        await insertLedgerEntry(trx, {
          ledgerTransactionId: txn.id,
          accountId: lockedTarget.id,
          direction: 'credit',
          amountMinor: amount,
          balanceAfterMinor: newTargetBalance,
          currency: input.currency,
        });
        await setAccountBalance(trx, lockedSystem.id, newSystemBalance);
        await setAccountBalance(trx, lockedTarget.id, newTargetBalance);

        const entries = await findEntriesByTransactionId(trx, txn.id);
        const view = toTransactionView(txn, entries);
        await gate.finalize(txn.id, 201, view as unknown as Record<string, unknown>);
        metrics.fundingTotal.inc();
        return { statusCode: 201, body: view };
      },
    );

    return outcome;
  }
}
