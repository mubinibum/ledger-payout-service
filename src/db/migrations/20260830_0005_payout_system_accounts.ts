import { type Kysely, sql } from 'kysely';
import { SUPPORTED_CURRENCIES } from './20260829_0003_system_account.js';

/**
 * Two more internal `system` accounts per currency for the payout flow:
 *
 *  - `system:payout_holding:<CUR>`   — holds reserved payout funds between "create payout"
 *    and the terminal outcome. A payout debits the source account and credits this; a
 *    settlement debits this and credits provider clearing; a release debits this and
 *    credits the source back.
 *  - `system:provider_clearing:<CUR>` — the "money has left to the provider" account. A
 *    settlement credits it. It is the ledger's representation of the external world.
 *
 * Neither allows overdraft: if the payout state machine is correct, holding is only ever
 * debited by an amount it was previously credited, so a negative balance would mean a bug
 * and the M2 `accounts_balance_nonneg` check aborts the transaction.
 */
const PAYOUT_SYSTEM_PURPOSES = ['payout_holding', 'provider_clearing'] as const;

export const m20260830_0005_payout_system_accounts = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const purpose of PAYOUT_SYSTEM_PURPOSES) {
        await sql`
          INSERT INTO accounts (external_id, type, currency, status, allow_overdraft, balance_minor)
          VALUES (${`system:${purpose}:${currency}`}, 'system', ${currency}, 'active', false, 0)
          ON CONFLICT (external_id) DO NOTHING
        `.execute(db);
      }
    }
  },

  async down(db: Kysely<unknown>): Promise<void> {
    for (const currency of SUPPORTED_CURRENCIES) {
      for (const purpose of PAYOUT_SYSTEM_PURPOSES) {
        await sql`DELETE FROM accounts WHERE external_id = ${`system:${purpose}:${currency}`}`.execute(
          db,
        );
      }
    }
  },
};

export { PAYOUT_SYSTEM_PURPOSES };
