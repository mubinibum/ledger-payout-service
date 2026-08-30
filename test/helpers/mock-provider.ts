import type { FastifyInstance } from 'fastify';
import { buildMockProvider } from '../../src/mock-provider/app.js';

export interface StartedMockProvider {
  app: FastifyInstance;
  baseUrl: string;
  setScenario(idempotencyKey: string, scenario: Record<string, unknown>): Promise<void>;
  complete(
    idempotencyKey: string,
    status: 'succeeded' | 'failed',
    failureCategory?: string,
  ): Promise<void>;
  fireWebhook(body: Record<string, unknown>): Promise<number>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Boots the mock provider on an ephemeral port. `webhookUrl` should point at the service
 * under test so `fireWebhook` reaches its `/v1/webhooks/provider/payouts` route.
 */
export async function startMockProvider(opts: {
  webhookUrl: string;
  webhookSecret: string;
  hangMs?: number;
}): Promise<StartedMockProvider> {
  const app = buildMockProvider(opts);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    app,
    baseUrl,
    async setScenario(idempotencyKey, scenario) {
      await post('/_control/scenario', { idempotencyKey, scenario });
    },
    async complete(idempotencyKey, status, failureCategory) {
      await post('/_control/complete', { idempotencyKey, status, failureCategory });
    },
    async fireWebhook(body) {
      const res = await post('/_control/fire-webhook', body);
      const json = (await res.json()) as { delivered: number };
      return json.delivered;
    },
    async reset() {
      await post('/_control/reset', {});
    },
    async stop() {
      await app.close();
    },
  };
}
