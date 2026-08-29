import type { Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { IdempotencyConflictError, RequestInProgressError } from '../../domain/errors.js';
import { metrics } from '../../infra/metrics.js';
import { completeRecord, findRecord, insertPendingRecord } from './idempotency.repository.js';

export interface IdempotentReplay {
  kind: 'replay';
  statusCode: number;
  body: Record<string, unknown>;
}

export interface IdempotentProceed {
  kind: 'proceed';
  /** Call once, inside the same transaction, after the operation's rows are written. */
  finalize: (
    resourceId: string,
    statusCode: number,
    body: Record<string, unknown>,
  ) => Promise<void>;
}

/**
 * Idempotency gate, run at the very start of a use-case transaction (before any row locks).
 *
 *  - fresh key            → `proceed`; caller does the work and calls `finalize`
 *  - same key, same body,
 *    first call completed  → `replay` with the stored response
 *  - same key, different
 *    body                  → `IdempotencyConflictError` (409)
 *  - same key, first call
 *    still running / rolled
 *    back mid-flight       → `RequestInProgressError` (409)
 *
 * A record is only ever committed in the `completed` state (pending rows live and die
 * inside their owning transaction), so a process restart cannot leave a poisoned key.
 */
export async function beginIdempotent(
  trx: Transaction<Database>,
  scope: string,
  key: string,
  fingerprint: string,
): Promise<IdempotentReplay | IdempotentProceed> {
  const inserted = await insertPendingRecord(trx, { scope, key, requestHash: fingerprint });

  if (inserted) {
    return {
      kind: 'proceed',
      finalize: (resourceId, statusCode, body) =>
        completeRecord(trx, inserted.id, { resourceId, statusCode, snapshot: body }),
    };
  }

  // Key exists and its owning transaction has already resolved (our INSERT blocked until
  // then). If it committed, the row is `completed`; if it rolled back, the row is gone.
  const existing = await findRecord(trx, scope, key);
  if (!existing) {
    throw new RequestInProgressError();
  }
  if (existing.request_hash !== fingerprint) {
    metrics.idempotencyConflictTotal.inc();
    throw new IdempotencyConflictError();
  }
  if (existing.status !== 'completed' || existing.response_snapshot === null) {
    throw new RequestInProgressError();
  }

  metrics.idempotencyReplayTotal.inc();
  return {
    kind: 'replay',
    statusCode: existing.response_status_code ?? 200,
    body: existing.response_snapshot,
  };
}
