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
export type LedgerTransactionType =
  'funding' | 'transfer' | 'payout_reservation' | 'payout_settlement' | 'payout_release';
export type LedgerTransactionStatus = 'committed';
export type EntryDirection = 'debit' | 'credit';
export type IdempotencyStatus = 'pending' | 'completed' | 'failed';

export type PayoutStatus =
  | 'requested'
  | 'queued'
  | 'processing'
  | 'submitted'
  | 'manual_review'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type OutboxStatus = 'pending' | 'published' | 'dead';

/** How a payout reached a definitive (settled/released) outcome. */
export type DefinitiveOutcomeSource =
  'webhook' | 'provider_status' | 'provider_rejection' | 'worker' | 'manual';

type MoneyColumn = ColumnType<bigint, bigint | number, bigint | number>;
type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;

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

export interface PayoutsTable {
  id: Generated<string>;
  external_id: string;
  source_account_id: string;
  amount_minor: MoneyColumn;
  currency: string;
  status: ColumnType<PayoutStatus, PayoutStatus | undefined, PayoutStatus>;
  provider: ColumnType<string, string | undefined, string>;
  provider_idempotency_key: string;
  provider_payout_id: ColumnType<string | null, string | null, string | null>;
  reservation_ledger_transaction_id: string;
  settlement_ledger_transaction_id: ColumnType<string | null, string | null, string | null>;
  release_ledger_transaction_id: ColumnType<string | null, string | null, string | null>;
  failure_category: ColumnType<string | null, string | null, string | null>;
  attempt_count: ColumnType<number, number | undefined, number>;
  reconcile_attempt_count: ColumnType<number, number | undefined, number>;
  version: ColumnType<number, number | undefined, number>;
  /** True once any outcome other than a proven-not-reached transport error has occurred. */
  provider_contact: ColumnType<boolean, boolean | undefined, boolean>;
  manual_review_reason: ColumnType<string | null, string | null, string | null>;
  manual_review_at: NullableTimestamp;
  last_reconciliation_outcome: ColumnType<string | null, string | null, string | null>;
  definitive_outcome_source: ColumnType<
    DefinitiveOutcomeSource | null,
    DefinitiveOutcomeSource | null,
    DefinitiveOutcomeSource | null
  >;
  submitted_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  next_reconcile_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: TimestampColumn;
}

export interface PayoutResolutionsTable {
  id: Generated<string>;
  payout_id: string;
  previous_status: string;
  new_status: string;
  resolution: string; // 'succeeded' | 'failed' | 'resumed' | 'rejected'
  reason: string;
  operator_reference: string;
  resulting_ledger_transaction_id: ColumnType<string | null, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: ColumnType<number, number | undefined, number>;
  payload: ColumnType<Record<string, unknown>, string, string>;
  status: ColumnType<OutboxStatus, OutboxStatus | undefined, OutboxStatus>;
  attempt_count: ColumnType<number, number | undefined, number>;
  available_at: TimestampColumn;
  locked_at: NullableTimestamp;
  published_at: NullableTimestamp;
  last_error: ColumnType<string | null, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface ProviderWebhookEventsTable {
  id: Generated<string>;
  provider_event_id: string;
  event_type: string;
  provider_payout_id: ColumnType<string | null, string | null, string | null>;
  payload_hash: string;
  result: ColumnType<string | null, string | null, string | null>;
  received_at: Generated<Date>;
  processed_at: NullableTimestamp;
}

export interface Database {
  accounts: AccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  idempotency_records: IdempotencyRecordsTable;
  payouts: PayoutsTable;
  payout_resolutions: PayoutResolutionsTable;
  outbox_events: OutboxEventsTable;
  provider_webhook_events: ProviderWebhookEventsTable;
}
