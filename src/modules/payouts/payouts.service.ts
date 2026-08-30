import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import {
  AccountNotActiveError,
  AccountNotFoundError,
  CurrencyMismatchError,
  PayoutNotCancellableError,
  PayoutNotFoundError,
  UnsupportedCurrencyError,
  ValidationError,
} from '../../domain/errors.js';
import { requestFingerprint } from '../../domain/fingerprint.js';
import type { FailureCategory } from '../../domain/provider-outcome.js';
import type { DefinitiveOutcomeSource } from '../../db/schema.js';
import {
  CANCELLABLE_STATUSES,
  type ManualReviewReason,
  type PayoutStatus,
} from '../../domain/payout-state.js';
import { maybeFault } from '../../infra/fault.js';
import { metrics } from '../../infra/metrics.js';
import { runInTransaction } from '../../infra/tx.js';
import type { Page } from '../../domain/types.js';
import {
  lockAccounts,
  findAccountById,
  findSystemAccount,
} from '../accounts/accounts.repository.js';
import { postBalancedTransfer } from '../ledger/ledger.service.js';
import { beginIdempotent } from '../idempotency/idempotency.service.js';
import { insertOutboxEvent } from '../outbox/outbox.repository.js';
import {
  claimStalePayouts,
  findPayoutById,
  insertPayout,
  listPayouts,
  toPayoutView,
  type PayoutRow,
  type PayoutView,
} from './payouts.repository.js';
import {
  markManualReviewWithin,
  markProcessingWithin,
  markRetryingWithin,
  markSubmittedWithin,
  releasePayoutWithin,
  rescheduleReconcileWithin,
  resumeReconcileWithin,
  settlePayoutWithin,
  type SettleReleaseResult,
  type TransitionSource,
} from './payout-transitions.js';

export interface CreatePayoutInput {
  sourceAccountId: string;
  amountMinor: bigint;
  currency: string;
  externalId?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface PayoutResult {
  statusCode: number;
  body: PayoutView | Record<string, unknown>;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;

export class PayoutsService {
  constructor(private readonly db: Kysely<Database>) {}

  // ---------------------------------------------------------------- create / read

  async createPayout(input: CreatePayoutInput, idempotencyKey: string): Promise<PayoutResult> {
    const { TRANSFER_MAX_RETRIES, PAYOUT_PROVIDER } = loadEnv();

    // The fingerprint covers only what the client actually sent. A client-supplied
    // externalId is semantic; an auto-generated one is not, so it is created only after
    // the idempotency gate (a replay returns the first payout regardless).
    const fingerprint = requestFingerprint('payout', {
      source: input.sourceAccountId,
      amount: input.amountMinor.toString(10),
      currency: input.currency,
      externalId: input.externalId ?? null,
      reference: input.reference ?? null,
      metadata: input.metadata ?? {},
    });

    return runInTransaction(this.db, { maxRetries: TRANSFER_MAX_RETRIES }, async (trx) => {
      const gate = await beginIdempotent(trx, 'payout', idempotencyKey, fingerprint);
      if (gate.kind === 'replay') return { statusCode: gate.statusCode, body: gate.body };

      const externalId = input.externalId ?? `po_${randomUUID()}`;

      const clash = await trx
        .selectFrom('payouts')
        .select('id')
        .where('external_id', '=', externalId)
        .executeTakeFirst();
      if (clash) throw new ValidationError('externalId is already in use', { externalId });

      const source = await findAccountById(trx, input.sourceAccountId);
      if (!source) throw new AccountNotFoundError(input.sourceAccountId);

      const holdingRef = await findSystemAccount(trx, 'payout_holding', input.currency);
      if (!holdingRef) throw new UnsupportedCurrencyError(input.currency);

      const locked = await lockAccounts(trx, [source.id, holdingRef.id].sort());
      const lockedSource = locked.find((r) => r.id === source.id);
      const lockedHolding = locked.find((r) => r.id === holdingRef.id);
      if (!lockedSource) throw new AccountNotFoundError(input.sourceAccountId);
      if (!lockedHolding) throw new UnsupportedCurrencyError(input.currency);

      if (lockedSource.status !== 'active') {
        throw new AccountNotActiveError(lockedSource.id, lockedSource.status);
      }
      if (lockedSource.currency.trim() !== input.currency) {
        throw new CurrencyMismatchError(lockedSource.currency.trim(), input.currency);
      }

      const reservation = await postBalancedTransfer(trx, {
        type: 'payout_reservation',
        reference: `payout:${externalId}`,
        metadata: { kind: 'payout_reservation', externalId },
        amountMinor: input.amountMinor,
        currency: input.currency,
        debitAccount: lockedSource,
        creditAccount: lockedHolding,
      });
      maybeFault('after_reservation_entries');

      const payoutId = randomUUID();
      let payout: PayoutRow;
      try {
        payout = await insertPayout(trx, {
          id: payoutId,
          externalId,
          sourceAccountId: lockedSource.id,
          amountMinor: input.amountMinor,
          currency: input.currency,
          provider: PAYOUT_PROVIDER,
          providerIdempotencyKey: externalId,
          reservationLedgerTransactionId: reservation.transactionId,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ValidationError('externalId is already in use', { externalId });
        }
        throw err;
      }

      maybeFault('after_payout_insert');

      await insertOutboxEvent(trx, {
        aggregateType: 'payout',
        aggregateId: payoutId,
        eventType: 'payout.requested',
        payload: { payoutId },
      });
      maybeFault('after_outbox_insert');

      const view = toPayoutView(payout);
      await gate.finalize(payoutId, 201, view as unknown as Record<string, unknown>);
      metrics.payoutsCreatedTotal.inc({ currency: input.currency });
      return { statusCode: 201, body: view };
    });
  }

  async getPayout(id: string): Promise<PayoutView> {
    const row = await findPayoutById(this.db, id);
    if (!row) throw new PayoutNotFoundError(id);
    return toPayoutView(row);
  }

  async listPayouts(opts: {
    status?: PayoutStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<PayoutView>> {
    return listPayouts(this.db, opts);
  }

  /**
   * Public cancellation. Allowed only when the payout is provably before any provider
   * submission: status `requested`/`queued` AND no `provider_contact` marker. The payout
   * row lock serialises this against the worker's `markProcessing`, so exactly one of
   * "cancelled" / "submitted to provider" wins.
   */
  async cancelPayout(id: string): Promise<PayoutView> {
    const row = await runInTransaction(this.db, { maxRetries: 3 }, async (trx) => {
      const payout = await trx
        .selectFrom('payouts')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!payout) throw new PayoutNotFoundError(id);
      if (payout.status === 'cancelled') return payout;
      if (!CANCELLABLE_STATUSES.has(payout.status) || payout.provider_contact) {
        throw new PayoutNotCancellableError(payout.status);
      }
      const { payout: updated } = await releasePayoutWithin(trx, id, {
        category: 'cancelled_before_submission',
        source: 'api',
        terminalStatus: 'cancelled',
        definitiveSource: 'manual',
      });
      metrics.payoutCancelledTotal.inc();
      return updated;
    });
    return toPayoutView(row);
  }

  // ---------------------------------------------------------------- transition wrappers
  // Each runs its own transaction; the *Within primitives compose into a caller's txn.

  markProcessing(payoutId: string): Promise<PayoutRow> {
    return runInTransaction(this.db, { maxRetries: 3 }, (trx) =>
      markProcessingWithin(trx, payoutId),
    );
  }

  markRetrying(payoutId: string): Promise<void> {
    return runInTransaction(this.db, { maxRetries: 3 }, (trx) => markRetryingWithin(trx, payoutId));
  }

  markSubmitted(
    payoutId: string,
    opts: { providerPayoutId?: string | null; ambiguous?: boolean },
  ): Promise<PayoutRow> {
    return runInTransaction(this.db, { maxRetries: 3 }, (trx) =>
      markSubmittedWithin(trx, payoutId, opts),
    );
  }

  applyProviderSuccess(
    payoutId: string,
    opts: {
      providerPayoutId?: string | null;
      source: TransitionSource;
      definitiveSource?: DefinitiveOutcomeSource;
    },
  ): Promise<SettleReleaseResult> {
    return runInTransaction(this.db, { maxRetries: 5 }, (trx) =>
      settlePayoutWithin(trx, payoutId, opts),
    );
  }

  applyProviderFailure(
    payoutId: string,
    opts: {
      category: FailureCategory;
      source: TransitionSource;
      terminalStatus?: PayoutStatus;
      definitiveSource?: DefinitiveOutcomeSource;
    },
  ): Promise<SettleReleaseResult> {
    return runInTransaction(this.db, { maxRetries: 5 }, (trx) =>
      releasePayoutWithin(trx, payoutId, opts),
    );
  }

  /** Route a payout to `manual_review` — funds stay reserved, no automatic processing. */
  markManualReview(payoutId: string, reason: ManualReviewReason): Promise<PayoutRow> {
    return runInTransaction(this.db, { maxRetries: 5 }, (trx) =>
      markManualReviewWithin(trx, payoutId, reason),
    );
  }

  resumeReconciliation(payoutId: string): Promise<PayoutRow> {
    return runInTransaction(this.db, { maxRetries: 3 }, (trx) =>
      resumeReconcileWithin(trx, payoutId),
    );
  }

  rescheduleReconcile(payoutId: string, lastOutcome?: string): Promise<void> {
    return runInTransaction(this.db, { maxRetries: 3 }, (trx) =>
      rescheduleReconcileWithin(trx, payoutId, lastOutcome),
    );
  }

  /**
   * Candidate stale payouts for reconciliation. `FOR UPDATE SKIP LOCKED` (on a single
   * autocommit statement) skips payouts another transaction is actively finishing; the
   * real double-apply guard is the per-payout row lock inside every transition.
   */
  findStaleForReconcile(): Promise<PayoutRow[]> {
    const env = loadEnv();
    return claimStalePayouts(this.db, {
      staleBefore: new Date(Date.now() - env.RECONCILE_STALE_AFTER_SEC * 1000),
      maxAttempts: env.RECONCILE_MAX_ATTEMPTS,
      limit: env.RECONCILE_BATCH_SIZE,
    });
  }
}
