import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { PayoutsTable, PayoutStatus } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';
import { encodeCursor, decodeCursor } from '../../http/pagination.js';
import type { Page } from '../../domain/types.js';

export type PayoutRow = Selectable<PayoutsTable>;

export interface PayoutView {
  id: string;
  externalId: string;
  sourceAccountId: string;
  amountMinor: string;
  currency: string;
  status: PayoutStatus;
  provider: string;
  providerPayoutId: string | null;
  failureCategory: string | null;
  attemptCount: number;
  reservationLedgerTransactionId: string;
  settlementLedgerTransactionId: string | null;
  releaseLedgerTransactionId: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPayoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    externalId: row.external_id,
    sourceAccountId: row.source_account_id,
    amountMinor: row.amount_minor.toString(10),
    currency: row.currency.trim(),
    status: row.status,
    provider: row.provider,
    providerPayoutId: row.provider_payout_id,
    failureCategory: row.failure_category,
    attemptCount: row.attempt_count,
    reservationLedgerTransactionId: row.reservation_ledger_transaction_id,
    settlementLedgerTransactionId: row.settlement_ledger_transaction_id,
    releaseLedgerTransactionId: row.release_ledger_transaction_id,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface InsertPayoutInput {
  id: string;
  externalId: string;
  sourceAccountId: string;
  amountMinor: bigint;
  currency: string;
  provider: string;
  providerIdempotencyKey: string;
  reservationLedgerTransactionId: string;
}

export async function insertPayout(db: Executor, input: InsertPayoutInput): Promise<PayoutRow> {
  return db
    .insertInto('payouts')
    .values({
      id: input.id,
      external_id: input.externalId,
      source_account_id: input.sourceAccountId,
      amount_minor: input.amountMinor,
      currency: input.currency,
      status: 'requested',
      provider: input.provider,
      provider_idempotency_key: input.providerIdempotencyKey,
      reservation_ledger_transaction_id: input.reservationLedgerTransactionId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findPayoutById(db: Executor, id: string): Promise<PayoutRow | undefined> {
  return db.selectFrom('payouts').selectAll().where('id', '=', id).executeTakeFirst();
}

/** Locks a payout row `FOR UPDATE`. Every state transition acquires this first. */
export async function lockPayout(db: Executor, id: string): Promise<PayoutRow | undefined> {
  return db.selectFrom('payouts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
}

export async function findPayoutByProviderRef(
  db: Executor,
  ref: string,
): Promise<PayoutRow | undefined> {
  return db
    .selectFrom('payouts')
    .selectAll()
    .where((eb) =>
      eb.or([eb('provider_payout_id', '=', ref), eb('provider_idempotency_key', '=', ref)]),
    )
    .executeTakeFirst();
}

export interface PayoutPatch {
  status?: PayoutStatus;
  providerPayoutId?: string | null;
  settlementLedgerTransactionId?: string;
  releaseLedgerTransactionId?: string;
  failureCategory?: string | null;
  submittedAt?: 'now' | null;
  completedAt?: 'now' | null;
  nextReconcileAt?: Date | null;
  incrementAttempt?: boolean;
  incrementReconcileAttempt?: boolean;
}

/** Applies a transition patch and always bumps `version` + `updated_at`. */
export async function updatePayout(
  db: Executor,
  id: string,
  patch: PayoutPatch,
): Promise<PayoutRow> {
  const set: Record<string, unknown> = {
    version: sql`version + 1`,
    updated_at: sql`now()`,
  };
  if (patch.status !== undefined) set['status'] = patch.status;
  if (patch.providerPayoutId !== undefined) set['provider_payout_id'] = patch.providerPayoutId;
  if (patch.settlementLedgerTransactionId !== undefined) {
    set['settlement_ledger_transaction_id'] = patch.settlementLedgerTransactionId;
  }
  if (patch.releaseLedgerTransactionId !== undefined) {
    set['release_ledger_transaction_id'] = patch.releaseLedgerTransactionId;
  }
  if (patch.failureCategory !== undefined) set['failure_category'] = patch.failureCategory;
  if (patch.submittedAt !== undefined) {
    set['submitted_at'] = patch.submittedAt === 'now' ? sql`now()` : null;
  }
  if (patch.completedAt !== undefined) {
    set['completed_at'] = patch.completedAt === 'now' ? sql`now()` : null;
  }
  if (patch.nextReconcileAt !== undefined) set['next_reconcile_at'] = patch.nextReconcileAt;
  if (patch.incrementAttempt) set['attempt_count'] = sql`attempt_count + 1`;
  if (patch.incrementReconcileAttempt) {
    set['reconcile_attempt_count'] = sql`reconcile_attempt_count + 1`;
  }

  return db
    .updateTable('payouts')
    .set(set)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

const MAX_PAGE = 100;

export async function listPayouts(
  db: Executor,
  opts: { status?: PayoutStatus; limit: number; cursor?: string },
): Promise<Page<PayoutView>> {
  const limit = Math.min(Math.max(opts.limit, 1), MAX_PAGE);
  let query = db
    .selectFrom('payouts')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1);

  if (opts.status) query = query.where('status', '=', opts.status);
  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    query = query.where(
      sql<boolean>`(payouts.created_at, payouts.id) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }

  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toPayoutView),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

/**
 * Claims a batch of stale non-terminal payouts for reconciliation using
 * `FOR UPDATE SKIP LOCKED`, so the worker and multiple reconciliation runs never fight
 * over the same payout.
 */
export async function claimStalePayouts(
  db: Executor,
  opts: { staleBefore: Date; maxAttempts: number; limit: number },
): Promise<PayoutRow[]> {
  return db
    .selectFrom('payouts')
    .selectAll()
    .where('status', 'in', ['submitted', 'processing'])
    .where('updated_at', '<', opts.staleBefore)
    .where('reconcile_attempt_count', '<', opts.maxAttempts)
    .where((eb) =>
      eb.or([eb('next_reconcile_at', 'is', null), eb('next_reconcile_at', '<=', sql<Date>`now()`)]),
    )
    .orderBy('updated_at', 'asc')
    .limit(opts.limit)
    .forUpdate()
    .skipLocked()
    .execute();
}

export interface PayoutStateCounts {
  status: PayoutStatus;
  count: number;
}

export async function payoutCountsByStatus(db: Executor): Promise<PayoutStateCounts[]> {
  const rows = await db
    .selectFrom('payouts')
    .select('status')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .groupBy('status')
    .execute();
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}
