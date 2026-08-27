import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { loadEnv } from './config/env.js';
import { loggerOptions } from './infra/logger.js';
import { registerRequestContext, requestIdFactory } from './plugins/request-context.js';
import { healthRoutes } from './modules/health/health.routes.js';

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

  await app.register(healthRoutes);

  app.get('/', () => ({
    name: 'ledger-payout-service',
    status: 'skeleton',
    milestone: 'M1',
    env: env.NODE_ENV,
  }));

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: 'not_found', path: request.url });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'unhandled_error');
    const status = error.statusCode ?? 500;
    void reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (error.code ?? 'error'),
      requestId: request.id,
    });
  });

  return app;
}
