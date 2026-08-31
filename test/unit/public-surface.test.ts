import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';

/**
 * Guards the public HTTP surface: no operator/debug endpoint is ever reachable, the
 * dev-only funding endpoint is closed unless opted in, and security headers are present.
 */
describe('unit: public HTTP surface', () => {
  let app: FastifyInstance;
  const routes: string[] = [];

  beforeAll(async () => {
    process.env['METRICS_ENABLED'] = 'true'; // widest surface
    delete process.env['ALLOW_FUNDING'];
    resetEnvCache();
    app = await buildApp(undefined, {
      onRoute: (r) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) routes.push(`${m} ${r.url}`);
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    delete process.env['METRICS_ENABLED'];
    resetEnvCache();
    await app.close();
    await closeDb();
    await closeRedis();
  });

  it('registers no admin / manual-review / fault / mock-provider / internal route', () => {
    for (const r of routes) {
      expect(r).not.toMatch(/admin|manual.?review|resolve|fault|mock.?provider|internal|debug/i);
    }
  });

  it('the only mutating payout routes are create and cancel', () => {
    const payoutWrites = routes
      .filter((r) => /^(POST|PUT|PATCH|DELETE) \/v1\/payouts/.test(r))
      .sort();
    expect(payoutWrites).toEqual(['POST /v1/payouts', 'POST /v1/payouts/:id/cancel']);
  });

  it('funding is closed by default (ALLOW_FUNDING unset → 403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts/11111111-1111-1111-1111-111111111111/funding',
      headers: { 'idempotency-key': 'k' },
      payload: { amount: '1', currency: 'USD' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('funding_disabled');
  });

  it('sends conservative security headers and no x-powered-by', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unknown routes get the structured 404 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/../secret' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
