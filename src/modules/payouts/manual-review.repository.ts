import type { Selectable } from 'kysely';
import type { PayoutResolutionsTable } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';

export type PayoutResolutionRow = Selectable<PayoutResolutionsTable>;

export interface NewResolution {
  payoutId: string;
  previousStatus: string;
  newStatus: string;
  /** 'succeeded' | 'failed' | 'resumed' | 'rejected' */
  resolution: string;
  reason: string;
  operatorReference: string;
  resultingLedgerTransactionId?: string | null;
}

export async function insertResolution(
  db: Executor,
  input: NewResolution,
): Promise<PayoutResolutionRow> {
  return db
    .insertInto('payout_resolutions')
    .values({
      payout_id: input.payoutId,
      previous_status: input.previousStatus,
      new_status: input.newStatus,
      resolution: input.resolution,
      reason: input.reason,
      operator_reference: input.operatorReference,
      resulting_ledger_transaction_id: input.resultingLedgerTransactionId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listResolutions(
  db: Executor,
  payoutId: string,
): Promise<PayoutResolutionRow[]> {
  return db
    .selectFrom('payout_resolutions')
    .selectAll()
    .where('payout_id', '=', payoutId)
    .orderBy('created_at', 'asc')
    .execute();
}
