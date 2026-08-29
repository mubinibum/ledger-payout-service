import { type Kysely, sql } from 'kysely';

/**
 * Seeds one internal `system` account per supported currency. Funding (the dev/test
 * affordance that gives an account an opening balance) is modelled as a balanced ledger
 * transaction: credit the target account, debit the matching system account. The system
 * account is the only account allowed to go negative (`allow_overdraft = true`) — its
 * negative balance is exactly the total value injected into the ledger during dev/test.
 *
 * Seeding here (rather than lazily in code) keeps the test schema identical to a
 * freshly-migrated production schema and avoids a create-race on first funding.
 */
const SUPPORTED_CURRENCIES = ['USD', 'IDR', 'EUR', 'SGD'] as const;

export const m20260829_0003_system_account = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const currency of SUPPORTED_CURRENCIES) {
      await sql`
        INSERT INTO accounts (external_id, type, currency, status, allow_overdraft, balance_minor)
        VALUES (${`system:funding:${currency}`}, 'system', ${currency}, 'active', true, 0)
        ON CONFLICT (external_id) DO NOTHING
      `.execute(db);
    }
  },

  async down(db: Kysely<unknown>): Promise<void> {
    for (const currency of SUPPORTED_CURRENCIES) {
      await sql`
        DELETE FROM accounts WHERE external_id = ${`system:funding:${currency}`}
      `.execute(db);
    }
  },
};

export { SUPPORTED_CURRENCIES };
