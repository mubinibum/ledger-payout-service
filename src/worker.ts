import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './infra/db.js';
import { logger } from './infra/logger.js';
import { onShutdown } from './infra/lifecycle.js';
import { closePayoutQueue } from './infra/queue.js';
import { closeRedis } from './infra/redis.js';
import { buildServices } from './composition.js';
import { createPayoutWorker } from './modules/payouts/payout.worker.js';

/** Entry point: the BullMQ payout worker. Run as its own process, separate from the API. */
function main(): void {
  loadEnv();
  const db = getDb();
  const services = buildServices(db);
  const worker = createPayoutWorker({
    db,
    service: services.payouts,
    provider: services.provider,
  });

  onShutdown(async () => {
    // `worker.close()` waits for in-flight jobs to finish (or their lock to expire).
    await worker.close();
    await Promise.allSettled([closePayoutQueue(), closeDb(), closeRedis()]);
  });

  worker.on('ready', () => logger.info('payout_worker_ready'));
  logger.info({ concurrency: loadEnv().WORKER_CONCURRENCY }, 'payout_worker_started');
}

main();
