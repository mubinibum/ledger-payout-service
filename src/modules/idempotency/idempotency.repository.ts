import type { Selectable } from 'kysely';
import type { IdempotencyRecordsTable } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';

export type IdempotencyRow = Selectable<IdempotencyRecordsTable>;

/**
 * Inserts a `pending` record for `(scope, key)`. Returns the row on success, or `null` if
 * the key already exists.
 *
 * Uses `ON CONFLICT DO NOTHING` rather than catching a unique-violation error: a raised
 * error would abort the surrounding transaction, whereas `ON CONFLICT` still blocks on a
 * concurrent *uncommitted* insert of the same key (serialising parallel same-key requests)
 * and then simply returns no row — leaving the transaction usable for the follow-up read.
 */
export async function insertPendingRecord(
  db: Executor,
  input: { scope: string; key: string; requestHash: string },
): Promise<IdempotencyRow | null> {
  const row = await db
    .insertInto('idempotency_records')
    .values({
      scope: input.scope,
      idempotency_key: input.key,
      request_hash: input.requestHash,
      status: 'pending',
    })
    .onConflict((oc) => oc.columns(['scope', 'idempotency_key']).doNothing())
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}

export async function findRecord(
  db: Executor,
  scope: string,
  key: string,
): Promise<IdempotencyRow | undefined> {
  return db
    .selectFrom('idempotency_records')
    .selectAll()
    .where('scope', '=', scope)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
}

export async function completeRecord(
  db: Executor,
  id: string,
  input: { resourceId: string; statusCode: number; snapshot: Record<string, unknown> },
): Promise<void> {
  await db
    .updateTable('idempotency_records')
    .set({
      status: 'completed',
      resource_id: input.resourceId,
      response_status_code: input.statusCode,
      response_snapshot: JSON.stringify(input.snapshot),
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
}
