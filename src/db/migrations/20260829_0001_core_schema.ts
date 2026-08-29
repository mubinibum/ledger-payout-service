import { type Kysely, sql } from 'kysely';

/**
 * Core M2 schema: accounts, ledger transactions, ledger entries, idempotency records.
 * Money columns are BIGINT (integer minor units). Enums are Postgres native enums.
 */
export const m20260829_0001_core_schema = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE TYPE account_status AS ENUM ('active', 'frozen', 'closed')`.execute(db);
    await sql`CREATE TYPE account_type AS ENUM ('user', 'system')`.execute(db);
    await sql`CREATE TYPE ledger_transaction_type AS ENUM ('funding', 'transfer')`.execute(db);
    await sql`CREATE TYPE ledger_transaction_status AS ENUM ('committed')`.execute(db);
    await sql`CREATE TYPE entry_direction AS ENUM ('debit', 'credit')`.execute(db);
    await sql`CREATE TYPE idempotency_status AS ENUM ('pending', 'completed', 'failed')`.execute(
      db,
    );

    await db.schema
      .createTable('accounts')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('external_id', 'text', (c) => c.notNull())
      .addColumn('type', sql`account_type`, (c) => c.notNull().defaultTo('user'))
      .addColumn('currency', sql`char(3)`, (c) => c.notNull())
      .addColumn('status', sql`account_status`, (c) => c.notNull().defaultTo('active'))
      .addColumn('allow_overdraft', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('balance_minor', 'bigint', (c) => c.notNull().defaultTo(0))
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('accounts_external_id_key', ['external_id'])
      .addCheckConstraint('accounts_currency_format', sql`currency ~ '^[A-Z]{3}$'`)
      .addCheckConstraint('accounts_balance_nonneg', sql`allow_overdraft OR balance_minor >= 0`)
      .execute();

    await db.schema
      .createTable('ledger_transactions')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('type', sql`ledger_transaction_type`, (c) => c.notNull())
      .addColumn('status', sql`ledger_transaction_status`, (c) =>
        c.notNull().defaultTo('committed'),
      )
      .addColumn('reference', 'text')
      .addColumn('metadata', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('ledger_transactions_reference_idx')
      .on('ledger_transactions')
      .column('reference')
      .where(sql.ref('reference'), 'is not', null)
      .execute();
    await db.schema
      .createIndex('ledger_transactions_created_at_idx')
      .on('ledger_transactions')
      .columns(['created_at', 'id'])
      .execute();

    await db.schema
      .createTable('ledger_entries')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('ledger_transaction_id', 'uuid', (c) =>
        c.notNull().references('ledger_transactions.id'),
      )
      .addColumn('account_id', 'uuid', (c) => c.notNull().references('accounts.id'))
      .addColumn('direction', sql`entry_direction`, (c) => c.notNull())
      .addColumn('amount_minor', 'bigint', (c) => c.notNull())
      .addColumn('balance_after', 'bigint', (c) => c.notNull())
      .addColumn('currency', sql`char(3)`, (c) => c.notNull())
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addCheckConstraint('ledger_entries_amount_positive', sql`amount_minor > 0`)
      .execute();

    await db.schema
      .createIndex('ledger_entries_account_history_idx')
      .on('ledger_entries')
      .columns(['account_id', 'created_at', 'id'])
      .execute();
    await db.schema
      .createIndex('ledger_entries_txn_idx')
      .on('ledger_entries')
      .column('ledger_transaction_id')
      .execute();

    await db.schema
      .createTable('idempotency_records')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('scope', 'text', (c) => c.notNull())
      .addColumn('idempotency_key', 'text', (c) => c.notNull())
      .addColumn('request_hash', 'text', (c) => c.notNull())
      .addColumn('status', sql`idempotency_status`, (c) => c.notNull().defaultTo('pending'))
      .addColumn('resource_id', 'uuid')
      .addColumn('response_snapshot', 'jsonb')
      .addColumn('response_status_code', 'smallint')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('idempotency_scope_key_uniq', ['scope', 'idempotency_key'])
      .execute();

    await db.schema
      .createIndex('idempotency_lookup_idx')
      .on('idempotency_records')
      .columns(['scope', 'idempotency_key'])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('idempotency_records').ifExists().execute();
    await db.schema.dropTable('ledger_entries').ifExists().execute();
    await db.schema.dropTable('ledger_transactions').ifExists().execute();
    await db.schema.dropTable('accounts').ifExists().execute();
    await sql`DROP TYPE IF EXISTS idempotency_status`.execute(db);
    await sql`DROP TYPE IF EXISTS entry_direction`.execute(db);
    await sql`DROP TYPE IF EXISTS ledger_transaction_status`.execute(db);
    await sql`DROP TYPE IF EXISTS ledger_transaction_type`.execute(db);
    await sql`DROP TYPE IF EXISTS account_type`.execute(db);
    await sql`DROP TYPE IF EXISTS account_status`.execute(db);
  },
};
