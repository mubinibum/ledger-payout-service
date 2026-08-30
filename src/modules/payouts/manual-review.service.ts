import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import {
  ContradictoryResolutionError,
  ManualReviewNotApplicableError,
  PayoutNotFoundError,
} from '../../domain/errors.js';
import { isTerminal } from '../../domain/payout-state.js';
import { metrics } from '../../infra/metrics.js';
import { runInTransaction } from '../../infra/tx.js';
import { lockPayout, toPayoutView, type PayoutView } from './payouts.repository.js';
import {
  releasePayoutWithin,
  resumeReconcileWithin,
  settlePayoutWithin,
} from './payout-transitions.js';
import { insertResolution, listResolutions } from './manual-review.repository.js';
import type { PayoutsService } from './payouts.service.js';

export interface ResolveInput {
  reason: string;
  operatorReference: string;
}

export interface ResolutionResult {
  payout: PayoutView;
  effect: 'applied' | 'noop';
}

export interface PayoutInspection {
  payout: PayoutView;
  resolutions: {
    previousStatus: string;
    newStatus: string;
    resolution: string;
    reason: string;
    operatorReference: string;
    resultingLedgerTransactionId: string | null;
    createdAt: string;
  }[];
}

/**
 * Internal, operator-only resolution of `manual_review` payouts. There is no public HTTP
 * surface — see `src/payout-admin.ts` for the local CLI. Every resolution writes a
 * `payout_resolutions` audit row (no credentials, no personal data).
 */
export class ManualReviewService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly payouts: PayoutsService,
  ) {}

  async inspect(payoutId: string): Promise<PayoutInspection> {
    const view = await this.payouts.getPayout(payoutId); // throws PayoutNotFoundError
    const rows = await listResolutions(this.db, payoutId);
    return {
      payout: view,
      resolutions: rows.map((r) => ({
        previousStatus: r.previous_status,
        newStatus: r.new_status,
        resolution: r.resolution,
        reason: r.reason,
        operatorReference: r.operator_reference,
        resultingLedgerTransactionId: r.resulting_ledger_transaction_id,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** Confirm the payout DID succeed at the provider → settle holding → clearing (once). */
  resolveSucceeded(payoutId: string, input: ResolveInput): Promise<ResolutionResult> {
    return this.resolve(payoutId, input, 'succeeded');
  }

  /** Confirm the payout DID NOT / will not pay → release holding → source (once). */
  resolveFailed(payoutId: string, input: ResolveInput): Promise<ResolutionResult> {
    return this.resolve(payoutId, input, 'failed');
  }

  private async resolve(
    payoutId: string,
    input: ResolveInput,
    direction: 'succeeded' | 'failed',
  ): Promise<ResolutionResult> {
    try {
      return await this.resolveInTx(payoutId, input, direction);
    } catch (err) {
      if (err instanceof ContradictoryResolutionError) {
        // Record the rejected attempt in its OWN transaction — the resolve transaction
        // rolled back, so the audit row would otherwise be lost.
        await insertResolution(this.db, {
          payoutId,
          previousStatus: err.details?.['existing'] as string,
          newStatus: err.details?.['existing'] as string,
          resolution: 'rejected',
          reason: input.reason,
          operatorReference: input.operatorReference,
        }).catch(() => undefined);
        metrics.payoutManualResolutionsTotal.inc({ resolution: direction, outcome: 'rejected' });
      }
      throw err;
    }
  }

  private resolveInTx(
    payoutId: string,
    input: ResolveInput,
    direction: 'succeeded' | 'failed',
  ): Promise<ResolutionResult> {
    return runInTransaction(this.db, { maxRetries: 5 }, async (trx) => {
      const payout = await lockPayout(trx, payoutId);
      if (!payout) throw new PayoutNotFoundError(payoutId);

      const alreadyThisDirection =
        (direction === 'succeeded' && payout.settlement_ledger_transaction_id) ||
        (direction === 'failed' && payout.release_ledger_transaction_id);
      if (alreadyThisDirection) {
        metrics.payoutManualResolutionsTotal.inc({ resolution: direction, outcome: 'noop' });
        return { payout: toPayoutView(payout), effect: 'noop' as const };
      }

      const oppositeEffect =
        (direction === 'succeeded' && payout.release_ledger_transaction_id) ||
        (direction === 'failed' && payout.settlement_ledger_transaction_id);
      if (oppositeEffect) {
        throw new ContradictoryResolutionError(payout.status, direction);
      }

      if (!isTerminal(payout.status) && payout.status !== 'manual_review') {
        throw new ManualReviewNotApplicableError(payout.status);
      }

      const outcome =
        direction === 'succeeded'
          ? await settlePayoutWithin(trx, payoutId, {
              source: 'manual',
              definitiveSource: 'manual',
            })
          : await releasePayoutWithin(trx, payoutId, {
              category: 'manual_resolution',
              source: 'manual',
              definitiveSource: 'manual',
            });

      const ledgerTxnId =
        direction === 'succeeded'
          ? outcome.payout.settlement_ledger_transaction_id
          : outcome.payout.release_ledger_transaction_id;

      await insertResolution(trx, {
        payoutId,
        previousStatus: payout.status,
        newStatus: outcome.payout.status,
        resolution: direction,
        reason: input.reason,
        operatorReference: input.operatorReference,
        resultingLedgerTransactionId: ledgerTxnId,
      });
      metrics.payoutManualResolutionsTotal.inc({ resolution: direction, outcome: outcome.effect });
      return { payout: toPayoutView(outcome.payout), effect: outcome.effect as 'applied' | 'noop' };
    });
  }

  /** Operator says it is safe to let automatic reconciliation try again. */
  resumeReconciliation(payoutId: string, input: ResolveInput): Promise<ResolutionResult> {
    return runInTransaction(this.db, { maxRetries: 3 }, async (trx) => {
      const payout = await lockPayout(trx, payoutId);
      if (!payout) throw new PayoutNotFoundError(payoutId);
      if (payout.status !== 'manual_review') {
        throw new ManualReviewNotApplicableError(payout.status);
      }
      const updated = await resumeReconcileWithin(trx, payoutId);
      await insertResolution(trx, {
        payoutId,
        previousStatus: 'manual_review',
        newStatus: updated.status,
        resolution: 'resumed',
        reason: input.reason,
        operatorReference: input.operatorReference,
      });
      metrics.payoutManualResolutionsTotal.inc({ resolution: 'resumed', outcome: 'applied' });
      return { payout: toPayoutView(updated), effect: 'applied' as const };
    });
  }
}
