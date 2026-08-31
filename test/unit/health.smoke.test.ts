import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';

describe('smoke: app skeleton', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    await closeRedis();
  });

  it('builds the app and serves the root descriptor', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'ledger-payout-service', env: 'test' });
  });

  it('GET /healthz is always 200 (liveness)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /readyz returns a well-formed readiness report', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json<{
      status: string;
      components: { postgres: string; redis: string };
    }>();
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.components).toHaveProperty('postgres');
    expect(body.components).toHaveProperty('redis');
  });

  it('echoes an x-request-id header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
