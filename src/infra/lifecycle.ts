import { logger } from './logger.js';

/**
 * Registers SIGINT/SIGTERM handlers that run `cleanup` once, with a hard deadline so a
 * stuck shutdown still exits. Used by every entry point (API, publisher, worker, mock
 * provider) so they all drain the same way.
 */
export function onShutdown(cleanup: () => Promise<void>, deadlineMs = 15_000): void {
  let shuttingDown = false;
  const handler = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting_down');
    const timer = setTimeout(() => {
      logger.error('shutdown_timeout');
      process.exit(1);
    }, deadlineMs);
    timer.unref();
    cleanup()
      .then(() => {
        clearTimeout(timer);
        logger.info('shutdown_complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
