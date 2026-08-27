import type { FastifyInstance } from 'fastify';
import { liveness, readiness } from './health.service.js';

/**
 * Operational endpoints:
 *   GET /healthz  — liveness  (always 200 while the process is up)
 *   GET /readyz   — readiness (200 when every dependency is reachable, 503 otherwise)
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', () => liveness());

  app.get('/readyz', async (_request, reply) => {
    const report = await readiness();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
}
