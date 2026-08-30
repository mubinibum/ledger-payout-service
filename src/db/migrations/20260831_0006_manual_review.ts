import { type Kysely, sql } from 'kysely';

/**
 * M3.1 — ambiguous-payout safety hardening.
 *
 * Adds the non-terminal `manual_review` payout status (funds stay reserved, no automatic
 * processing, resolvable only by an explicit internal action), the columns that back it,
 * and a `payout_resolutions` audit table. Also strengthens the payout CHECK constraints:
 * a `manual_review` payout must have NO settlement and NO release.
 */
export const m20260831_0006_manual_review = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'manual_review'`.execute(db);

    await db.schema
      .alterTable('payouts')
      .addColumn('provider_contact', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('manual_review_reason', 'text')
      .addColumn('manual_review_at', 'timestamptz')
      .addColumn('last_reconciliation_outcome', 'text')
      .addColumn('definitive_outcome_source', 'text')
      .execute();

    // A manual_review payout carries no accounting effect yet — funds are still in holding.
    // `status::text` avoids referencing the just-added enum value as a literal, which
    // PostgreSQL forbids inside the transaction that added it.
    await sql`
      ALTER TABLE payouts ADD CONSTRAINT payouts_manual_review_no_effect
        CHECK (status::text <> 'manual_review'
               OR (settlement_ledger_transaction_id IS NULL
                   AND release_ledger_transaction_id IS NULL))
    `.execute(db);

    await db.schema
      .createTable('payout_resolutions')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('payout_id', 'uuid', (c) => c.notNull().references('payouts.id'))
      .addColumn('previous_status', 'text', (c) => c.notNull())
      .addColumn('new_status', 'text', (c) => c.notNull())
      .addColumn('resolution', 'text', (c) => c.notNull())
      .addColumn('reason', 'text', (c) => c.notNull())
      .addColumn('operator_reference', 'text', (c) => c.notNull())
      .addColumn('resulting_ledger_transaction_id', 'uuid', (c) =>
        c.references('ledger_transactions.id'),
      )
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('payout_resolutions_payout_idx')
      .on('payout_resolutions')
      .column('payout_id')
      .execute();

    // Index for "how many payouts are stuck in manual_review, and for how long".
    // (Non-partial — a partial predicate on an enum cast is not IMMUTABLE.)
    await db.schema
      .createIndex('payouts_manual_review_idx')
      .on('payouts')
      .columns(['status', 'manual_review_at'])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('payout_resolutions').ifExists().execute();
    await sql`ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_manual_review_no_effect`.execute(
      db,
    );
    await db.schema
      .alterTable('payouts')
      .dropColumn('provider_contact')
      .dropColumn('manual_review_reason')
      .dropColumn('manual_review_at')
      .dropColumn('last_reconciliation_outcome')
      .dropColumn('definitive_outcome_source')
      .execute();
    await sql`DROP INDEX IF EXISTS payouts_manual_review_idx`.execute(db);
    // The `manual_review` enum value stays — PostgreSQL has no `ALTER TYPE ... DROP VALUE`.
    // It is harmless if unused; `ADD VALUE IF NOT EXISTS` makes re-running `up` safe.
  },
};
