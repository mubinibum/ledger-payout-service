import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { metrics } from '../../src/infra/metrics.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';
import { closePayoutQueue } from '../../src/infra/queue.js';
import { closeTestDb } from '../helpers/pg.js';
import { resetDb } from '../helpers/pg.js';
import { createAccount, fundAccount, transfer } from '../helpers/factories.js';

/**
 * End-to-end: a real transfer flow moves the domain counters, and the exposition reflects
 * it — with only bounded, identifier-free labels.
 */
describe('integration: /metrics reflects a real flow', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env['METRICS_ENABLED'] = 'true';
    resetEnvCache();
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    delete process.env['METRICS_ENABLED'];
    resetEnvCache();
    metrics.reset();
    await app.close();
    await closePayoutQueue();
    await closeDb();
    await closeRedis();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    metrics.reset();
  });

  it('increments transfers_total and http_requests_total after a committed transfer', async () => {
    const src = await createAccount(app, { currency: 'USD' });
    const dst = await createAccount(app, { currency: 'USD' });
    await fundAccount(app, src.id, '10000', { currency: 'USD' });

    const before = metrics.transfersTotal.get();
    const res = await transfer(app, {
      sourceAccountId: src.id,
      destinationAccountId: dst.id,
      amount: '2500',
      currency: 'USD',
    });
    expect(res.statusCode).toBe(201);

    expect(metrics.transfersTotal.get()).toBe(before + 1);

    const exposition = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(exposition).toMatch(/^transfers_total 1$/m);
    expect(exposition).toContain(
      'http_requests_total{method="POST",route="/v1/transfers",status_class="2xx"}',
    );
    // the concrete account ids must never appear as a label
    expect(exposition).not.toContain(src.id);
    expect(exposition).not.toContain(dst.id);
  });

  it('increments transfers_failed_total{code=...} on a rejected transfer', async () => {
    const src = await createAccount(app, { currency: 'USD' });
    const dst = await createAccount(app, { currency: 'USD' });

    const res = await transfer(app, {
      sourceAccountId: src.id,
      destinationAccountId: dst.id,
      amount: '999999',
      currency: 'USD',
    });
    expect(res.statusCode).toBe(422);

    const exposition = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(exposition).toMatch(/transfers_failed_total\{code="insufficient_funds"\} 1/);
  });
});
