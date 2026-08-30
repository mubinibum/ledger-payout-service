import { type Kysely, sql } from 'kysely';

/**
 * M3 schema: payouts, transactional outbox, provider webhook receipts.
 *
 * Payout value movement reuses the M2 ledger: three new `ledger_transaction_type` values
 * (`payout_reservation`, `payout_settlement`, `payout_release`), each still a balanced
 * >= 2-entry transaction checked by the M2 deferred trigger. Money never moves without a
 * ledger transaction.
 */
export const m20260830_0004_payout_schema = {
  async up(db: Kysely<unknown>): Promise<void> {
    // New ledger transaction types. PG 16 allows ADD VALUE inside a transaction as long as
    // the value is not used in the same transaction — these migrations only touch DDL and
    // seed accounts, never insert a ledger_transactions row.
    await sql`ALTER TYPE ledger_transaction_type ADD VALUE IF NOT EXISTS 'payout_reservation'`.execute(
      db,
    );
    await sql`ALTER TYPE ledger_transaction_type ADD VALUE IF NOT EXISTS 'payout_settlement'`.execute(
      db,
    );
    await sql`ALTER TYPE ledger_transaction_type ADD VALUE IF NOT EXISTS 'payout_release'`.execute(
      db,
    );

    await sql`
      CREATE TYPE payout_status AS ENUM
        ('requested', 'queued', 'processing', 'submitted', 'succeeded', 'failed', 'cancelled')
    `.execute(db);
    await sql`CREATE TYPE outbox_status AS ENUM ('pending', 'published', 'dead')`.execute(db);

    await db.schema
      .createTable('payouts')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('external_id', 'text', (c) => c.notNull())
      .addColumn('source_account_id', 'uuid', (c) => c.notNull().references('accounts.id'))
      .addColumn('amount_minor', 'bigint', (c) => c.notNull())
      .addColumn('currency', sql`char(3)`, (c) => c.notNull())
      .addColumn('status', sql`payout_status`, (c) => c.notNull().defaultTo('requested'))
      .addColumn('provider', 'text', (c) => c.notNull().defaultTo('mock'))
      .addColumn('provider_idempotency_key', 'text', (c) => c.notNull())
      .addColumn('provider_payout_id', 'text')
      .addColumn('reservation_ledger_transaction_id', 'uuid', (c) =>
        c.notNull().references('ledger_transactions.id'),
      )
      .addColumn('settlement_ledger_transaction_id', 'uuid', (c) =>
        c.references('ledger_transactions.id'),
      )
      .addColumn('release_ledger_transaction_id', 'uuid', (c) =>
        c.references('ledger_transactions.id'),
      )
      .addColumn('failure_category', 'text')
      .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('reconcile_attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('version', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('submitted_at', 'timestamptz')
      .addColumn('completed_at', 'timestamptz')
      .addColumn('next_reconcile_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('payouts_external_id_key', ['external_id'])
      .addUniqueConstraint('payouts_provider_idem_key', ['provider_idempotency_key'])
      .addUniqueConstraint('payouts_provider_payout_id_key', ['provider_payout_id'])
      .addCheckConstraint('payouts_amount_positive', sql`amount_minor > 0`)
      .addCheckConstraint('payouts_currency_format', sql`currency ~ '^[A-Z]{3}$'`)
      .addCheckConstraint(
        'payouts_settle_xor_release',
        sql`settlement_ledger_transaction_id IS NULL OR release_ledger_transaction_id IS NULL`,
      )
      .addCheckConstraint(
        'payouts_succeeded_has_settlement',
        sql`status <> 'succeeded' OR settlement_ledger_transaction_id IS NOT NULL`,
      )
      .addCheckConstraint(
        'payouts_terminal_fail_has_release',
        sql`status NOT IN ('failed', 'cancelled') OR release_ledger_transaction_id IS NOT NULL`,
      )
      .execute();

    await db.schema
      .createIndex('payouts_status_updated_idx')
      .on('payouts')
      .columns(['status', 'updated_at'])
      .execute();
    await db.schema
      .createIndex('payouts_reconcile_idx')
      .on('payouts')
      .columns(['next_reconcile_at'])
      .where(sql<boolean>`status in ('submitted', 'processing')`)
      .execute();
    await db.schema
      .createIndex('payouts_source_account_idx')
      .on('payouts')
      .columns(['source_account_id', 'created_at'])
      .execute();

    await db.schema
      .createTable('outbox_events')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('aggregate_type', 'text', (c) => c.notNull())
      .addColumn('aggregate_id', 'uuid', (c) => c.notNull())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('schema_version', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('payload', 'jsonb', (c) => c.notNull())
      .addColumn('status', sql`outbox_status`, (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('available_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('locked_at', 'timestamptz')
      .addColumn('published_at', 'timestamptz')
      .addColumn('last_error', 'text')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('outbox_pending_idx')
      .on('outbox_events')
      .columns(['available_at', 'created_at'])
      .where(sql<boolean>`status = 'pending'`)
      .execute();
    await db.schema
      .createIndex('outbox_aggregate_idx')
      .on('outbox_events')
      .columns(['aggregate_type', 'aggregate_id'])
      .execute();

    await db.schema
      .createTable('provider_webhook_events')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('provider_event_id', 'text', (c) => c.notNull())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('provider_payout_id', 'text')
      .addColumn('payload_hash', 'text', (c) => c.notNull())
      .addColumn('result', 'text')
      .addColumn('received_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('processed_at', 'timestamptz')
      .addUniqueConstraint('provider_webhook_event_id_key', ['provider_event_id'])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('provider_webhook_events').ifExists().execute();
    await db.schema.dropTable('outbox_events').ifExists().execute();
    await db.schema.dropTable('payouts').ifExists().execute();
    await sql`DROP TYPE IF EXISTS outbox_status`.execute(db);
    await sql`DROP TYPE IF EXISTS payout_status`.execute(db);
    // Note: enum VALUES added to ledger_transaction_type are intentionally NOT removed —
    // PostgreSQL has no `ALTER TYPE ... DROP VALUE`. They are harmless if unused.
  },
};
