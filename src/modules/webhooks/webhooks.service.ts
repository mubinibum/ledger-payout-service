import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import {
  WebhookConflictError,
  WebhookNotConfiguredError,
  WebhookSignatureInvalidError,
  WebhookTimestampInvalidError,
} from '../../domain/errors.js';
import { verifyWebhook } from '../../domain/webhook-signature.js';
import { maybeFault } from '../../infra/fault.js';
import { logger } from '../../infra/logger.js';
import { metrics } from '../../infra/metrics.js';
import { runInTransaction } from '../../infra/tx.js';
import { findPayoutByProviderRef } from '../payouts/payouts.repository.js';
import { releasePayoutWithin, settlePayoutWithin } from '../payouts/payout-transitions.js';
import { providerWebhookBody } from './webhooks.schemas.js';
import {
  findWebhookEvent,
  insertWebhookEvent,
  markWebhookProcessed,
} from './webhooks.repository.js';

export interface WebhookRequest {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  eventIdHeader: string | undefined;
}

export interface WebhookOutcome {
  statusCode: number;
  body: { received: true; result: string; replay: boolean };
}

/**
 * Verifies a signed provider webhook against the **raw** body, then applies it exactly
 * once. The receipt insert and the payout transition commit in one transaction; a
 * concurrent duplicate blocks on the unique `provider_event_id` and then replays the first
 * result. A different payload under the same event id is a `409`.
 */
export class WebhookService {
  constructor(private readonly db: Kysely<Database>) {}

  async handle(req: WebhookRequest): Promise<WebhookOutcome> {
    const env = loadEnv();
    if (!env.WEBHOOK_SECRET) {
      throw new WebhookNotConfiguredError();
    }

    const verification = verifyWebhook({
      rawBody: req.rawBody,
      signatureHeader: req.signatureHeader,
      timestampHeader: req.timestampHeader,
      secret: env.WEBHOOK_SECRET,
      toleranceSeconds: env.WEBHOOK_TOLERANCE_SEC,
    });
    if (!verification.ok) {
      metrics.webhookRejectedTotal.inc({ reason: verification.reason });
      if (verification.reason === 'timestamp') throw new WebhookTimestampInvalidError();
      throw new WebhookSignatureInvalidError();
    }

    // Parse only after the signature is proven, so unsigned bodies never reach the parser.
    const parsed = providerWebhookBody.parse(JSON.parse(req.rawBody.toString('utf8')));
    const providerEventId =
      req.eventIdHeader && req.eventIdHeader.length > 0 ? req.eventIdHeader : parsed.eventId;
    const payloadHash = createHash('sha256').update(req.rawBody).digest('hex');

    const outcome = await runInTransaction(this.db, { maxRetries: 5 }, async (trx) => {
      const inserted = await insertWebhookEvent(trx, {
        providerEventId,
        eventType: parsed.type,
        providerPayoutId: parsed.providerPayoutId ?? null,
        payloadHash,
      });

      if (!inserted) {
        const existing = await findWebhookEvent(trx, providerEventId);
        if (!existing) return { result: 'in_progress', replay: true };
        if (existing.payload_hash !== payloadHash) {
          throw new WebhookConflictError();
        }
        return { result: existing.result ?? 'processed', replay: true };
      }

      const payout = await findPayoutByProviderRef(
        trx,
        parsed.idempotencyKey || (parsed.providerPayoutId ?? ''),
      );
      if (!payout) {
        await markWebhookProcessed(trx, inserted.id, 'payout_not_found');
        logger.warn({ providerEventId, type: parsed.type }, 'webhook_payout_not_found');
        return { result: 'payout_not_found', replay: false };
      }

      maybeFault('webhook_accounting_transition');

      let result: string;
      if (parsed.type === 'payout.succeeded') {
        const updated = await settlePayoutWithin(trx, payout.id, {
          providerPayoutId: parsed.providerPayoutId ?? null,
          source: 'webhook',
        });
        result = updated.status === 'succeeded' ? 'applied_success' : 'noop';
      } else {
        const updated = await releasePayoutWithin(trx, payout.id, {
          category: 'permanent_rejection',
          source: 'webhook',
        });
        result = updated.status === 'failed' ? 'applied_failure' : 'noop_terminal';
      }
      await markWebhookProcessed(trx, inserted.id, result);
      return { result, replay: false };
    });

    if (outcome.replay) {
      metrics.webhookReplayedTotal.inc();
    } else {
      metrics.webhookAcceptedTotal.inc({ event_type: parsed.type });
    }
    return {
      statusCode: 200,
      body: { received: true, result: outcome.result, replay: outcome.replay },
    };
  }
}
