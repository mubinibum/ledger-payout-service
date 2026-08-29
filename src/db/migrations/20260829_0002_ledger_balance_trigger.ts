import { type Kysely, sql } from 'kysely';

/**
 * The core accounting invariant — "every ledger transaction has >= 2 entries and its
 * debits equal its credits" — cannot be expressed as a row-level CHECK constraint
 * (it spans rows). It is enforced by a DEFERRED constraint trigger that runs at
 * COMMIT: if any touched ledger transaction is unbalanced or under-sized, the whole
 * database transaction is rolled back. The service layer builds balanced entries;
 * this trigger is the backstop that makes a service bug impossible to persist.
 */
export const m20260829_0002_ledger_balance_trigger = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`
      CREATE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger AS $$
      DECLARE
        txn_id uuid := COALESCE(NEW.ledger_transaction_id, OLD.ledger_transaction_id);
        entry_count integer;
        imbalance bigint;
      BEGIN
        SELECT count(*),
               COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0)
          INTO entry_count, imbalance
          FROM ledger_entries
         WHERE ledger_transaction_id = txn_id;

        IF entry_count < 2 THEN
          RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required', txn_id, entry_count
            USING ERRCODE = 'check_violation';
        END IF;

        IF imbalance <> 0 THEN
          RAISE EXCEPTION 'ledger transaction % is unbalanced (debits - credits = %)', txn_id, imbalance
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `.execute(db);

    await sql`
      CREATE CONSTRAINT TRIGGER ledger_entries_balanced
        AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced()
    `.execute(db);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries`.execute(db);
    await sql`DROP FUNCTION IF EXISTS assert_ledger_transaction_balanced()`.execute(db);
  },
};
