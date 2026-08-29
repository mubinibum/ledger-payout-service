import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types for the M2 schema. These are hand-maintained and must stay in sync
 * with `src/db/migrations/*`. Money is `bigint` (integer minor units) end to end.
 *
 * ColumnType<Select, Insert, Update>:
 *  - amounts/balances are `bigint` on read, and accept `bigint | number` on write.
 *  - `Generated<T>` marks DB-defaulted columns that are optional on insert.
 */

export type AccountStatus = 'active' | 'frozen' | 'closed';
export type AccountType = 'user' | 'system';
export type LedgerTransactionType = 'funding' | 'transfer';
export type LedgerTransactionStatus = 'committed';
export type EntryDirection = 'debit' | 'credit';
export type IdempotencyStatus = 'pending' | 'completed' | 'failed';

type MoneyColumn = ColumnType<bigint, bigint | number, bigint | number>;
type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;

export interface AccountsTable {
  id: Generated<string>;
  external_id: string;
  type: ColumnType<AccountType, AccountType | undefined, never>;
  currency: string;
  status: ColumnType<AccountStatus, AccountStatus | undefined, AccountStatus>;
  allow_overdraft: ColumnType<boolean, boolean | undefined, boolean>;
  balance_minor: ColumnType<bigint, bigint | number | undefined, bigint | number>;
  created_at: Generated<Date>;
  updated_at: TimestampColumn;
}

export interface LedgerTransactionsTable {
  id: Generated<string>;
  type: LedgerTransactionType;
  status: ColumnType<LedgerTransactionStatus, LedgerTransactionStatus | undefined, never>;
  reference: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, never>;
  created_at: Generated<Date>;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  ledger_transaction_id: string;
  account_id: string;
  direction: EntryDirection;
  amount_minor: MoneyColumn;
  balance_after: MoneyColumn;
  currency: string;
  created_at: Generated<Date>;
}

export interface IdempotencyRecordsTable {
  id: Generated<string>;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: ColumnType<IdempotencyStatus, IdempotencyStatus | undefined, IdempotencyStatus>;
  resource_id: string | null;
  response_snapshot: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  response_status_code: number | null;
  created_at: Generated<Date>;
  updated_at: TimestampColumn;
}

export interface Database {
  accounts: AccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  idempotency_records: IdempotencyRecordsTable;
}
