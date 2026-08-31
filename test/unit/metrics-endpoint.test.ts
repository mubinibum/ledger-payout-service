import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { resetEnvCache } from '../../src/config/env.js';
import { metrics } from '../../src/infra/metrics.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';

async function build(metricsEnabled: boolean): Promise<FastifyInstance> {
  if (metricsEnabled) process.env['METRICS_ENABLED'] = 'true';
  else delete process.env['METRICS_ENABLED'];
  resetEnvCache();
  const app = await buildApp();
  await app.ready();
  return app;
}

describe('unit: GET /metrics', () => {
  afterEach(() => {
    delete process.env['METRICS_ENABLED'];
    resetEnvCache();
    metrics.reset();
  });
  afterAll(async () => {
    await closeDb();
    await closeRedis();
  });

  it('is not registered by default → 404 with the normal error envelope', async () => {
    const app = await build(false);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  it('serves Prometheus text with the right content type when enabled', async () => {
    const app = await build(true);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('exposes the required metric families', async () => {
    const app = await build(true);
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    for (const name of [
      'http_requests_total',
      'http_request_duration_seconds',
      'transfers_total',
      'payouts_created_total',
      'payout_manual_review_entered_total',
      'provider_attempts_total',
      'provider_ambiguous_outcomes_total',
      'payout_manual_review',
      'outbox_pending',
      'outbox_dead',
      'worker_dlq_total',
      'webhook_accepted_total',
      'webhook_rejected_total',
      'reconciliation_outcomes_total',
      'payouts_reserved_beyond_threshold',
    ]) {
      expect(body, name).toContain(`# TYPE ${name} `);
    }
    await app.close();
  });

  it('records HTTP metrics with bounded labels after real requests', async () => {
    const app = await build(true);
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/v1/accounts/11111111-1111-1111-1111-111111111111' });
    await app.inject({ method: 'GET', url: '/nope' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toMatch(/http_requests_total\{[^}]*route="\/healthz"[^}]*\} [1-9]/);
    // the concrete uuid must NOT appear; the route template must
    expect(body).not.toContain('11111111-1111-1111-1111-111111111111');
    expect(body).toContain('route="/v1/accounts/:id"');
    expect(body).toContain('route="__unmatched__"'); // the 404
    await app.close();
  });

  it('contains no id-, secret-, or message-shaped label values', async () => {
    const app = await build(true);
    await app.inject({ method: 'GET', url: '/v1/payouts/22222222-2222-2222-2222-222222222222' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    const labelValues = [...body.matchAll(/\{([^}]*)\}/g)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((kv) => kv.split('=')[1]?.replace(/"/g, '') ?? '');
    for (const v of labelValues) {
      expect(v).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(v).not.toMatch(/^\d{7,}$/);
      expect(v).not.toMatch(/secret|bearer|password/i);
    }
    await app.close();
  });
});
