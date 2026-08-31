import type { FastifyInstance } from 'fastify';
import { metrics } from '../../infra/metrics.js';

/**
 * Prometheus exposition endpoint.
 *
 *   GET /metrics   →   200 text/plain; version=0.0.4   (only when METRICS_ENABLED=true)
 *
 * This plugin is registered by `buildApp` ONLY when `METRICS_ENABLED` is true. When the
 * flag is false the route does not exist and a request falls through to the 404 handler —
 * there is no "disabled" branch to misconfigure.
 *
 * The exposition is deliberately identifier-free: every label is a bounded enum, an HTTP
 * method, a status class, or a normalised route template. No payout/account/idempotency/
 * provider id, raw reference, or error message is ever a label value (enforced by
 * `test/integration/metrics.test.ts`).
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(metrics.render());
  });
}
