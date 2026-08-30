import type { Kysely } from 'kysely';
import type { Database } from './db/schema.js';
import { AccountsService } from './modules/accounts/accounts.service.js';
import { TransfersService } from './modules/transfers/transfers.service.js';
import { PayoutsService } from './modules/payouts/payouts.service.js';
import { markQueuedWithin } from './modules/payouts/payout-transitions.js';
import { ReconciliationService } from './modules/payouts/reconciliation.service.js';
import { ManualReviewService } from './modules/payouts/manual-review.service.js';
import { WebhookService } from './modules/webhooks/webhooks.service.js';
import { MockProviderClient } from './modules/provider/mock-provider.client.js';
import type { ProviderPort } from './modules/provider/provider.port.js';
import type { OutboxSideEffect } from './modules/outbox/outbox.publisher.js';

/**
 * The composition root: builds every service from a database handle (and an optional
 * provider override, which the integration tests use to point at an ephemeral mock).
 * Nothing else in the codebase constructs services — routes and the worker/publisher entry
 * points all receive them from here.
 */
export interface Services {
  accounts: AccountsService;
  transfers: TransfersService;
  payouts: PayoutsService;
  webhooks: WebhookService;
  reconciliation: ReconciliationService;
  manualReview: ManualReviewService;
  provider: ProviderPort;
}

export function buildServices(
  db: Kysely<Database>,
  opts: { provider?: ProviderPort } = {},
): Services {
  const provider = opts.provider ?? new MockProviderClient();
  const payouts = new PayoutsService(db);
  return {
    accounts: new AccountsService(db),
    transfers: new TransfersService(db),
    payouts,
    webhooks: new WebhookService(db),
    reconciliation: new ReconciliationService(db, payouts, provider),
    manualReview: new ManualReviewService(db, payouts),
    provider,
  };
}

/**
 * Runs inside the outbox publisher's transaction after an event is marked published.
 * Nudges the payout `requested → queued` so the API status reflects "it's on the queue".
 * Idempotent.
 */
export function payoutOutboxSideEffect(): OutboxSideEffect {
  return async (trx, event) => {
    if (event.aggregate_type === 'payout' && event.event_type === 'payout.requested') {
      await markQueuedWithin(trx, event.aggregate_id);
    }
  };
}
