import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env.js';
import { getDb } from './infra/db.js';
import { loggerOptions } from './infra/logger.js';
import { registerRequestContext, requestIdFactory } from './plugins/request-context.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { accountsRoutes } from './modules/accounts/accounts.routes.js';
import { transfersRoutes } from './modules/transfers/transfers.routes.js';
import { payoutRoutes } from './modules/payouts/payouts.routes.js';
import { webhookRoutes } from './modules/webhooks/webhooks.routes.js';
import { buildServices, type Services } from './composition.js';
import { sendError } from './http/errors.js';

/**
 * Builds the Fastify application without starting a listener. Kept separate from
 * `index.ts` so tests can exercise the app in-process (`app.inject`). Tests may pass their
 * own `Services` (e.g. a provider pointed at an ephemeral mock).
 */
export async function buildApp(services?: Services): Promise<FastifyInstance> {
  const env = loadEnv();
  const svc = services ?? buildServices(getDb());

  const app = Fastify({
    logger: loggerOptions(),
    genReqId: (req) => requestIdFactory(req),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  registerRequestContext(app);

  await app.register(healthRoutes);
  await app.register(accountsRoutes({ accounts: svc.accounts }));
  await app.register(transfersRoutes({ transfers: svc.transfers }));
  await app.register(payoutRoutes({ payouts: svc.payouts }));
  await app.register(webhookRoutes({ webhooks: svc.webhooks }));

  app.get('/', () => ({
    name: 'ledger-payout-service',
    status: 'in-development',
    milestone: 'M3',
    env: env.NODE_ENV,
  }));

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: 'not_found', message: 'route not found' },
      requestId: request.id,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Fastify's own errors (malformed JSON, payload too large, …) carry a <500 statusCode.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      void reply.code(error.statusCode).send({
        error: { code: error.code ?? 'bad_request', message: error.message },
        requestId: request.id,
      });
      return;
    }
    void sendError(request, reply, error);
  });

  return app;
}
