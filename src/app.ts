import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env.js';
import { getDb } from './infra/db.js';
import { loggerOptions } from './infra/logger.js';
import { registerRequestContext, requestIdFactory } from './plugins/request-context.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { AccountsService } from './modules/accounts/accounts.service.js';
import { accountsRoutes } from './modules/accounts/accounts.routes.js';
import { TransfersService } from './modules/transfers/transfers.service.js';
import { transfersRoutes } from './modules/transfers/transfers.routes.js';
import { sendError } from './http/errors.js';

/**
 * Builds the Fastify application without starting a listener. Kept separate from
 * `index.ts` so tests can exercise the app in-process (`app.inject`).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger: loggerOptions(),
    genReqId: (req) => requestIdFactory(req),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  registerRequestContext(app);

  const db = getDb();
  const accounts = new AccountsService(db);
  const transfers = new TransfersService(db);

  await app.register(healthRoutes);
  await app.register(accountsRoutes({ accounts }));
  await app.register(transfersRoutes({ transfers }));

  app.get('/', () => ({
    name: 'ledger-payout-service',
    status: 'in-development',
    milestone: 'M2',
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
