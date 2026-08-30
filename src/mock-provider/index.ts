import { loadEnv } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { onShutdown } from '../infra/lifecycle.js';
import { buildMockProvider } from './app.js';

/**
 * Entry point: the LOCAL-ONLY mock payout provider. Never enabled as part of the real
 * service runtime — it is its own process, started explicitly for local development or
 * demos (`npm run mock-provider`).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET must be set so the mock provider can sign test webhooks');
  }
  const app = buildMockProvider({
    webhookUrl: env.MOCK_PROVIDER_WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
  });

  onShutdown(async () => {
    await app.close();
  });

  await app.listen({ host: '127.0.0.1', port: env.MOCK_PROVIDER_PORT });
  logger.info({ port: env.MOCK_PROVIDER_PORT }, 'mock_provider_listening');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'mock_provider_startup_failed');
  process.exit(1);
});
