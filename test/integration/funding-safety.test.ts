import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetEnvCache } from '../../src/config/env.js';
import { startApp, stopApp } from '../helpers/app.js';
import { resetDb } from '../helpers/pg.js';
import { createAccount } from '../helpers/factories.js';

/**
 * The funding endpoint creates money and must be off unless a developer explicitly opts in.
 * `ALLOW_FUNDING` defaults to `false`; the rest of the suite turns it on in `test/setup.ts`.
 */
describe('integration: funding safety', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await stopApp(app);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    process.env['ALLOW_FUNDING'] = 'true';
    resetEnvCache();
  });

  it('defaults to disabled — the endpoint returns 403 when ALLOW_FUNDING is not "true"', async () => {
    const account = await createAccount(app, { currency: 'USD' });

    delete process.env['ALLOW_FUNDING'];
    resetEnvCache();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${account.id}/funding`,
      headers: { 'idempotency-key': 'fund-disabled-1' },
      payload: { amount: '1000', currency: 'USD' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('funding_disabled');
  });

  it('stores nothing when funding is rejected as disabled', async () => {
    const account = await createAccount(app, { currency: 'USD' });

    process.env['ALLOW_FUNDING'] = 'false';
    resetEnvCache();

    await app.inject({
      method: 'POST',
      url: `/v1/accounts/${account.id}/funding`,
      headers: { 'idempotency-key': 'fund-disabled-2' },
      payload: { amount: '1000', currency: 'USD' },
    });

    const detail = await app.inject({ method: 'GET', url: `/v1/accounts/${account.id}` });
    expect(detail.json<{ account: { balanceMinor: string } }>().account.balanceMinor).toBe('0');
  });
});
