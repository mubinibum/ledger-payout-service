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
import { metricsRoutes } from './modules/metrics/metrics.routes.js';
import { buildServices, type Services } from './composition.js';
import { sendError } from './http/errors.js';
import { metrics } from './infra/metrics.js';

/** Bucket a status code into a bounded label so `/metrics` stays low-cardinality. */
function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

/** The route template for metrics/logs — never the concrete URL (which carries ids). */
function routeLabel(url: string | undefined): string {
  return url && url.length > 0 ? url : '__unmatched__';
}

export interface BuildAppOptions {
  /** Route-introspection hook — used by `scripts/openapi-check.mjs` and the OpenAPI drift
   * test to enumerate the registered surface without booting dependencies. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

/**
 * Builds the Fastify application without starting a listener. Kept separate from
 * `index.ts` so tests can exercise the app in-process (`app.inject`). Tests may pass their
 * own `Services` (e.g. a provider pointed at an ephemeral mock).
 */
export async function buildApp(
  services?: Services,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const env = loadEnv();
  const svc = services ?? buildServices(getDb());

  const app = Fastify({
    logger: loggerOptions(),
    genReqId: (req) => requestIdFactory(req),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  if (opts.onRoute) {
    app.addHook('onRoute', (r) => opts.onRoute?.({ method: r.method, url: r.url }));
  }

  registerRequestContext(app);

  // Conservative security headers on every response. This is an API with no browser UI, so
  // the set is small and static; a CSP is intentionally omitted (no HTML is served).
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.removeHeader('x-powered-by');
    return payload;
  });

  // HTTP metrics. Recorded unconditionally (cheap, in-process); only *exposed* when
  // METRICS_ENABLED. Labels are bounded: method, route template, status class.
  app.addHook('onResponse', async (request, reply) => {
    const route = routeLabel(request.routeOptions?.url);
    const method = request.method;
    metrics.httpRequestsTotal.inc({
      method,
      route,
      status_class: statusClass(reply.statusCode),
    });
    metrics.httpRequestDurationSeconds.observe(reply.elapsedTime / 1000, { method, route });
  });

  await app.register(healthRoutes);
  if (env.METRICS_ENABLED) {
    await app.register(metricsRoutes);
  }
  await app.register(accountsRoutes({ accounts: svc.accounts }));
  await app.register(transfersRoutes({ transfers: svc.transfers }));
  await app.register(payoutRoutes({ payouts: svc.payouts }));
  await app.register(webhookRoutes({ webhooks: svc.webhooks }));

  app.get('/', () => ({
    name: 'ledger-payout-service',
    description:
      'Double-entry ledger and payout service — an engineering demonstration, not a real financial service.',
    docs: 'openapi/openapi.yaml',
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
