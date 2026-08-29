import type { Migration } from 'kysely';
import { m20260829_0001_core_schema } from './20260829_0001_core_schema.js';
import { m20260829_0002_ledger_balance_trigger } from './20260829_0002_ledger_balance_trigger.js';
import { m20260829_0003_system_account } from './20260829_0003_system_account.js';

/**
 * Migrations keyed by their timestamped name. Kysely runs them in lexicographic key
 * order, so the `YYYYMMDD_NNNN_*` prefix defines execution order. Explicit static
 * imports (no filesystem globbing) keep this deterministic under both `tsx` and the
 * compiled build.
 */
export const migrations: Record<string, Migration> = {
  '20260829_0001_core_schema': m20260829_0001_core_schema,
  '20260829_0002_ledger_balance_trigger': m20260829_0002_ledger_balance_trigger,
  '20260829_0003_system_account': m20260829_0003_system_account,
};
