import type {
  AccountStatus,
  AccountType,
  EntryDirection,
  LedgerTransactionType,
} from '../db/schema.js';

/**
 * Domain/API shapes. These are the only representations that leave the service — internal
 * columns (numeric ids, the `pending` idempotency status, raw metadata bounds) are not
 * exposed. Amounts are strings of minor units (see `domain/money.ts`).
 */

export interface Account {
  id: string;
  externalId: string;
  type: AccountType;
  currency: string;
  status: AccountStatus;
  allowOverdraft: boolean;
  balanceMinor: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  ledgerTransactionId: string;
  accountId: string;
  direction: EntryDirection;
  amountMinor: string;
  balanceAfterMinor: string;
  currency: string;
  createdAt: string;
}

export interface LedgerTransactionView {
  id: string;
  type: LedgerTransactionType;
  status: 'committed';
  reference: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  entries: LedgerEntryView[];
}

/** A transfer is a `type = 'transfer'` ledger transaction; its id is the transfer id. */
export type TransferView = LedgerTransactionView;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateAccountInput {
  externalId: string;
  currency: string;
  allowOverdraft: boolean;
}

export interface FundAccountInput {
  accountId: string;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
}

export interface TransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  metadata: Record<string, unknown>;
}
