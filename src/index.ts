import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logger } from './infra/logger.js';
import { closeDb } from './infra/db.js';
import { closeRedis } from './infra/redis.js';
import { closePayoutQueue } from './infra/queue.js';
import { onShutdown } from './infra/lifecycle.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();

  onShutdown(async () => {
    await app.close();
    await Promise.allSettled([closePayoutQueue(), closeDb(), closeRedis()]);
  });

  await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  logger.info({ host: env.HTTP_HOST, port: env.HTTP_PORT }, 'listening');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'startup_failed');
  process.exit(1);
});
