import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { logger } from './infra/logger.js';
import { closeDb } from './infra/db.js';
import { closeRedis } from './infra/redis.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting_down');
    app
      .close()
      .then(() => Promise.allSettled([closeDb(), closeRedis()]))
      .then(() => {
        logger.info('shutdown_complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  logger.info({ host: env.HTTP_HOST, port: env.HTTP_PORT }, 'listening');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'startup_failed');
  process.exit(1);
});
