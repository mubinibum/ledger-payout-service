import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { DefinitiveOutcomeSource, PayoutsTable, PayoutStatus } from '../../db/schema.js';
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
  reconcileAttemptCount: number;
  providerContact: boolean;
  manualReviewReason: string | null;
  manualReviewAt: string | null;
  lastReconciliationOutcome: string | null;
  definitiveOutcomeSource: string | null;
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
    reconcileAttemptCount: row.reconcile_attempt_count,
    providerContact: row.provider_contact,
    manualReviewReason: row.manual_review_reason,
    manualReviewAt: row.manual_review_at ? new Date(row.manual_review_at).toISOString() : null,
    lastReconciliationOutcome: row.last_reconciliation_outcome,
    definitiveOutcomeSource: row.definitive_outcome_source,
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
  resetReconcileAttempt?: boolean;
  providerContact?: boolean;
  manualReviewReason?: string | null;
  manualReviewAt?: 'now' | null;
  lastReconciliationOutcome?: string | null;
  definitiveOutcomeSource?: DefinitiveOutcomeSource | null;
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
  if (patch.resetReconcileAttempt) set['reconcile_attempt_count'] = 0;
  if (patch.providerContact !== undefined) set['provider_contact'] = patch.providerContact;
  if (patch.manualReviewReason !== undefined) {
    set['manual_review_reason'] = patch.manualReviewReason;
  }
  if (patch.manualReviewAt !== undefined) {
    set['manual_review_at'] = patch.manualReviewAt === 'now' ? sql`now()` : null;
  }
  if (patch.lastReconciliationOutcome !== undefined) {
    set['last_reconciliation_outcome'] = patch.lastReconciliationOutcome;
  }
  if (patch.definitiveOutcomeSource !== undefined) {
    set['definitive_outcome_source'] = patch.definitiveOutcomeSource;
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

export interface PayoutSafetyStats {
  byStatus: Record<string, number>;
  manualReview: number;
  manualReviewOldestSeconds: number | null;
  reservedBeyondThreshold: number;
  outboxDeadWithReservedPayout: number;
}

/** One query pass for the safety gauges (manual-review backlog, stuck reservations, …). */
export async function payoutSafetyStats(
  db: Executor,
  reservedThresholdSeconds: number,
): Promise<PayoutSafetyStats> {
  const statusRows = await db
    .selectFrom('payouts')
    .select('status')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .groupBy('status')
    .execute();
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.count);

  const mr = await db
    .selectFrom('payouts')
    .select((eb) => eb.fn.min('manual_review_at').as('oldest'))
    .where('status', '=', 'manual_review')
    .executeTakeFirst();

  // Payouts still holding reserved funds (submitted / manual_review / processing) older
  // than the alert threshold.
  const reserved = await db
    .selectFrom('payouts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('status', 'in', ['submitted', 'manual_review', 'processing', 'queued', 'requested'])
    .where(
      'created_at',
      '<',
      sql<Date>`now() - (${reservedThresholdSeconds} || ' seconds')::interval`,
    )
    .executeTakeFirstOrThrow();

  const deadOutbox = await db
    .selectFrom('outbox_events as o')
    .innerJoin('payouts as p', 'p.id', 'o.aggregate_id')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('o.status', '=', 'dead')
    .where('o.aggregate_type', '=', 'payout')
    .where('p.status', 'in', ['requested', 'queued', 'submitted', 'manual_review', 'processing'])
    .executeTakeFirstOrThrow();

  return {
    byStatus,
    manualReview: byStatus['manual_review'] ?? 0,
    manualReviewOldestSeconds: mr?.oldest
      ? Math.round((Date.now() - new Date(mr.oldest).getTime()) / 1000)
      : null,
    reservedBeyondThreshold: Number(reserved.n),
    outboxDeadWithReservedPayout: Number(deadOutbox.n),
  };
}
