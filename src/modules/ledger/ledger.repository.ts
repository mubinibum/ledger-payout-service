import type { Selectable } from 'kysely';
import type { LedgerEntriesTable, LedgerTransactionsTable } from '../../db/schema.js';
import type { EntryDirection, LedgerTransactionType } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';
import type { LedgerEntryView, LedgerTransactionView } from '../../domain/types.js';

export type LedgerTransactionRow = Selectable<LedgerTransactionsTable>;
export type LedgerEntryRow = Selectable<LedgerEntriesTable>;

export interface NewLedgerTransaction {
  type: LedgerTransactionType;
  reference: string | null;
  metadata: Record<string, unknown>;
}

export interface NewLedgerEntry {
  ledgerTransactionId: string;
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  currency: string;
}

export async function insertLedgerTransaction(
  db: Executor,
  input: NewLedgerTransaction,
): Promise<LedgerTransactionRow> {
  return db
    .insertInto('ledger_transactions')
    .values({
      type: input.type,
      status: 'committed',
      reference: input.reference,
      metadata: JSON.stringify(input.metadata),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertLedgerEntry(
  db: Executor,
  input: NewLedgerEntry,
): Promise<LedgerEntryRow> {
  return db
    .insertInto('ledger_entries')
    .values({
      ledger_transaction_id: input.ledgerTransactionId,
      account_id: input.accountId,
      direction: input.direction,
      amount_minor: input.amountMinor,
      balance_after: input.balanceAfterMinor,
      currency: input.currency,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findLedgerTransactionById(
  db: Executor,
  id: string,
): Promise<LedgerTransactionRow | undefined> {
  return db.selectFrom('ledger_transactions').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findEntriesByTransactionId(
  db: Executor,
  transactionId: string,
): Promise<LedgerEntryRow[]> {
  return db
    .selectFrom('ledger_entries')
    .selectAll()
    .where('ledger_transaction_id', '=', transactionId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export function toEntryView(row: LedgerEntryRow): LedgerEntryView {
  return {
    id: row.id,
    ledgerTransactionId: row.ledger_transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    amountMinor: row.amount_minor.toString(10),
    balanceAfterMinor: row.balance_after.toString(10),
    currency: row.currency.trim(),
    createdAt: row.created_at.toISOString(),
  };
}

export function toTransactionView(
  txn: LedgerTransactionRow,
  entries: LedgerEntryRow[],
): LedgerTransactionView {
  return {
    id: txn.id,
    type: txn.type,
    status: 'committed',
    reference: txn.reference,
    metadata: txn.metadata,
    createdAt: txn.created_at.toISOString(),
    entries: entries.map(toEntryView),
  };
}
