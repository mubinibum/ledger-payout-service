import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from '../../src/db/schema.js';
import { SUPPORTED_CURRENCIES } from '../../src/db/migrations/20260829_0003_system_account.js';

/**
 * A Kysely handle to the shared test database started by `test/global-setup.ts`. This is
 * for direct assertions in tests (reading balances, counting entries); the app under test
 * uses its own pool via `getDb()`, pointed at the same `DATABASE_URL`.
 */
let db: Kysely<Database> | undefined;

export function testDb(): Kysely<Database> {
  if (db) return db;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — is test/global-setup.ts running?');
  }
  pg.types.setTypeParser(20, (value: string): bigint => BigInt(value));
  const pool = new pg.Pool({ connectionString, max: 20 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return db;
}

/** Truncates every table and re-seeds the system accounts (migration 0003 data). */
export async function resetDb(): Promise<void> {
  const d = testDb();
  await sql`TRUNCATE ledger_entries, ledger_transactions, idempotency_records, accounts RESTART IDENTITY CASCADE`.execute(
    d,
  );
  for (const currency of SUPPORTED_CURRENCIES) {
    await d
      .insertInto('accounts')
      .values({
        external_id: `system:funding:${currency}`,
        type: 'system',
        currency,
        status: 'active',
        allow_overdraft: true,
        balance_minor: 0n,
      })
      .execute();
  }
}

export async function closeTestDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = undefined;
  }
}

/** Sum of every account balance — the ledger's total system value. */
export async function totalSystemValue(): Promise<bigint> {
  const rows = await testDb().selectFrom('accounts').select('balance_minor').execute();
  return rows.reduce((acc, r) => acc + r.balance_minor, 0n);
}

/** Asserts every ledger transaction has >= 2 entries that net to zero. */
export async function assertAllTransactionsBalanced(): Promise<void> {
  const rows = await sql<{
    ledger_transaction_id: string;
    entry_count: string;
    net: string;
  }>`
    SELECT ledger_transaction_id,
           count(*) AS entry_count,
           COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS net
      FROM ledger_entries
     GROUP BY ledger_transaction_id
  `.execute(testDb());

  for (const row of rows.rows) {
    if (Number(row.entry_count) < 2) {
      throw new Error(`transaction ${row.ledger_transaction_id} has ${row.entry_count} entries`);
    }
    if (BigInt(row.net) !== 0n) {
      throw new Error(`transaction ${row.ledger_transaction_id} is unbalanced (net ${row.net})`);
    }
  }
}
