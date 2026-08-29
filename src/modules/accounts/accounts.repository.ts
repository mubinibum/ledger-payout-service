import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { AccountsTable } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';
import type { Account } from '../../domain/types.js';
import { encodeCursor, decodeCursor } from '../../http/pagination.js';
import type { LedgerEntryView, Page } from '../../domain/types.js';

export type AccountRow = Selectable<AccountsTable>;

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    externalId: row.external_id,
    type: row.type,
    currency: row.currency.trim(),
    status: row.status,
    allowOverdraft: row.allow_overdraft,
    balanceMinor: row.balance_minor.toString(10),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreateAccountRow {
  external_id: string;
  currency: string;
  allow_overdraft: boolean;
}

export async function insertAccount(db: Executor, values: CreateAccountRow): Promise<AccountRow> {
  return db
    .insertInto('accounts')
    .values({ ...values, type: 'user', status: 'active' })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findAccountById(db: Executor, id: string): Promise<AccountRow | undefined> {
  return db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findAccountByExternalId(
  db: Executor,
  externalId: string,
): Promise<AccountRow | undefined> {
  return db
    .selectFrom('accounts')
    .selectAll()
    .where('external_id', '=', externalId)
    .executeTakeFirst();
}

/**
 * Locks the given accounts `FOR UPDATE`, returned in ascending id order. Callers pass a
 * de-duplicated id list; locking in a single deterministic order is what prevents a
 * deadlock between two transfers that touch the same pair of accounts in opposite roles.
 */
export async function lockAccounts(db: Executor, ids: readonly string[]): Promise<AccountRow[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('accounts')
    .selectAll()
    .where('id', 'in', [...ids])
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
}

/** Finds the internal system funding account for a currency (used by the funding flow). */
export async function findSystemAccount(
  db: Executor,
  currency: string,
): Promise<AccountRow | undefined> {
  return db
    .selectFrom('accounts')
    .selectAll()
    .where('type', '=', 'system')
    .where('currency', '=', currency)
    .executeTakeFirst();
}

export async function setAccountBalance(
  db: Executor,
  id: string,
  balanceMinor: bigint,
): Promise<void> {
  await db
    .updateTable('accounts')
    .set({ balance_minor: balanceMinor, updated_at: sql`now()` })
    .where('id', '=', id)
    .execute();
}

const MAX_PAGE = 100;

export async function listLedgerEntries(
  db: Executor,
  accountId: string,
  opts: { limit: number; cursor?: string },
): Promise<Page<LedgerEntryView>> {
  const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);

  let query = db
    .selectFrom('ledger_entries')
    .selectAll()
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1);

  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    query = query.where(
      sql<boolean>`(ledger_entries.created_at, ledger_entries.id) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }

  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: LedgerEntryView[] = page.map((row) => ({
    id: row.id,
    ledgerTransactionId: row.ledger_transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    amountMinor: row.amount_minor.toString(10),
    balanceAfterMinor: row.balance_after.toString(10),
    currency: row.currency.trim(),
    createdAt: row.created_at.toISOString(),
  }));

  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
      : null;

  return { items, nextCursor };
}
