import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError } from '../../src/http/errors.js';
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  ValidationError,
} from '../../src/domain/errors.js';

async function appThatThrows(err: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/boom', (request, reply) => sendError(request, reply, err));
  await app.ready();
  return app;
}

describe('DomainError → HTTP mapping', () => {
  const cases: [unknown, number, string][] = [
    [new ValidationError('bad'), 400, 'validation_error'],
    [new AccountNotFoundError('x'), 404, 'account_not_found'],
    [new CurrencyMismatchError('USD', 'EUR'), 409, 'currency_mismatch'],
    [new InsufficientFundsError('x'), 422, 'insufficient_funds'],
    [new IdempotencyConflictError(), 409, 'idempotency_conflict'],
  ];

  for (const [err, status, code] of cases) {
    it(`${code} → ${status}`, async () => {
      const app = await appThatThrows(err);
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ error: { code } });
      await app.close();
    });
  }

  it('a ZodError becomes a 400 validation_error with issues', async () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: 'no' });
    const app = await appThatThrows(parsed.success ? null : parsed.error);
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details: { issues: unknown[] } } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    await app.close();
  });

  it('an unknown error becomes a 500 with no internal detail', async () => {
    const app = await appThatThrows(new Error('secret db string'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret db string');
    expect(res.json()).toMatchObject({ error: { code: 'internal_error' } });
    await app.close();
  });
});
