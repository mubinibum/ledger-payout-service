import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './infra/db.js';
import { logger } from './infra/logger.js';
import { onShutdown } from './infra/lifecycle.js';
import { bullEnqueuer, closePayoutQueue } from './infra/queue.js';
import {
  OutboxPublisher,
  outboxPublisherOptionsFromEnv,
} from './modules/outbox/outbox.publisher.js';
import { payoutOutboxSideEffect } from './composition.js';
import { refreshPayoutSafetyGauges } from './modules/payouts/payout-metrics.js';

/** Entry point: the transactional-outbox relay. Run as its own process. */
function main(): void {
  loadEnv();
  const db = getDb();
  const publisher = new OutboxPublisher(db, bullEnqueuer(), {
    ...outboxPublisherOptionsFromEnv(),
    sideEffect: payoutOutboxSideEffect(),
    afterCycle: () => refreshPayoutSafetyGauges(db),
  });

  onShutdown(async () => {
    await publisher.stop();
    await Promise.allSettled([closePayoutQueue(), closeDb()]);
  });

  publisher.start();
  logger.info('outbox_publisher_started');
}

main();
