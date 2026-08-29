import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startApp, stopApp } from '../helpers/app.js';
import { resetDb, testDb, totalSystemValue } from '../helpers/pg.js';
import { createAccount, fundAccount } from '../helpers/factories.js';

describe('integration: accounts + funding', () => {
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

  it('creates an account and returns its detail with a zero balance', async () => {
    const created = await createAccount(app, { externalId: 'wallet-1', currency: 'USD' });
    expect(created.balanceMinor).toBe('0');
    expect(created.status).toBe('active');

    const res = await app.inject({ method: 'GET', url: `/v1/accounts/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ account: { id: string; balanceMinor: string } }>().account).toMatchObject({
      id: created.id,
      balanceMinor: '0',
    });
  });

  it('rejects a duplicate externalId', async () => {
    await createAccount(app, { externalId: 'dup' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      payload: { externalId: 'dup', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('funds an account via a balanced ledger transaction (never a direct balance write)', async () => {
    const acct = await createAccount(app, { currency: 'USD' });
    const { statusCode, body } = await fundAccount(app, acct.id, '150000');
    expect(statusCode).toBe(201);

    const txn = (body as { ledgerTransaction: { id: string; type: string; entries: unknown[] } })
      .ledgerTransaction;
    expect(txn.type).toBe('funding');
    expect(txn.entries).toHaveLength(2);

    // Account balance moved; system account went equally negative → total value unchanged.
    const detail = await app.inject({ method: 'GET', url: `/v1/accounts/${acct.id}` });
    expect(detail.json<{ account: { balanceMinor: string } }>().account.balanceMinor).toBe(
      '150000',
    );
    expect(await totalSystemValue()).toBe(0n);

    const system = await testDb()
      .selectFrom('accounts')
      .selectAll()
      .where('external_id', '=', 'system:funding:USD')
      .executeTakeFirstOrThrow();
    expect(system.balance_minor).toBe(-150000n);
  });

  it('returns ledger history in deterministic newest-first order with keyset pagination', async () => {
    const acct = await createAccount(app, { currency: 'USD' });
    for (let i = 1; i <= 5; i += 1) {
      await fundAccount(app, acct.id, String(i * 100));
    }

    const first = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${acct.id}/ledger-entries?limit=2`,
    });
    const firstBody = first.json<{
      entries: { amountMinor: string }[];
      nextCursor: string | null;
    }>();
    expect(firstBody.entries).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(firstBody.entries.map((e) => e.amountMinor)).toEqual(['500', '400']);

    const second = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${acct.id}/ledger-entries?limit=2&cursor=${encodeURIComponent(
        firstBody.nextCursor!,
      )}`,
    });
    const secondBody = second.json<{ entries: { amountMinor: string }[] }>();
    expect(secondBody.entries.map((e) => e.amountMinor)).toEqual(['300', '200']);
  });

  it('rejects funding a frozen account', async () => {
    const acct = await createAccount(app, { currency: 'USD' });
    await testDb()
      .updateTable('accounts')
      .set({ status: 'frozen' })
      .where('id', '=', acct.id)
      .execute();

    const { statusCode, body } = await fundAccount(app, acct.id, '1000');
    expect(statusCode).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('account_not_active');
  });

  it('rejects funding with a currency the account does not use', async () => {
    const acct = await createAccount(app, { currency: 'USD' });
    const { statusCode, body } = await fundAccount(app, acct.id, '1000', { currency: 'EUR' });
    expect(statusCode).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('currency_mismatch');
  });

  it('requires an Idempotency-Key on funding', async () => {
    const acct = await createAccount(app, { currency: 'USD' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${acct.id}/funding`,
      payload: { amount: '1000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');
  });
});
