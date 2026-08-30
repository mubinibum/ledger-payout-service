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

/** Entry point: the transactional-outbox relay. Run as its own process. */
function main(): void {
  loadEnv();
  const publisher = new OutboxPublisher(getDb(), bullEnqueuer(), {
    ...outboxPublisherOptionsFromEnv(),
    sideEffect: payoutOutboxSideEffect(),
  });

  onShutdown(async () => {
    await publisher.stop();
    await Promise.allSettled([closePayoutQueue(), closeDb()]);
  });

  publisher.start();
  logger.info('outbox_publisher_started');
}

main();
