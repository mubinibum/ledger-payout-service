import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { startApp, stopApp } from '../helpers/app.js';
import { assertAllTransactionsBalanced, resetDb, testDb, totalSystemValue } from '../helpers/pg.js';
import { createAccount, fundAccount, transfer } from '../helpers/factories.js';

async function fundedAccount(
  app: FastifyInstance,
  amount: string,
  currency = 'USD',
): Promise<string> {
  const acct = await createAccount(app, { currency });
  await fundAccount(app, acct.id, amount, { currency });
  return acct.id;
}

async function balanceOf(app: FastifyInstance, id: string): Promise<bigint> {
  const res = await app.inject({ method: 'GET', url: `/v1/accounts/${id}` });
  return BigInt(res.json<{ account: { balanceMinor: string } }>().account.balanceMinor);
}

describe('integration: internal transfers', () => {
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

  it('moves value with a balanced 2-entry ledger transaction', async () => {
    const source = await fundedAccount(app, '10000');
    const destination = await createAccount(app, { currency: 'USD' });

    const { statusCode, body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '2500',
    });
    expect(statusCode).toBe(201);

    const txn = (
      body as { transfer: { id: string; type: string; entries: { direction: string }[] } }
    ).transfer;
    expect(txn.type).toBe('transfer');
    expect(txn.entries).toHaveLength(2);
    expect(txn.entries.map((e) => e.direction).sort()).toEqual(['credit', 'debit']);

    await assertAllTransactionsBalanced();
  });

  it('decreases the source and increases the destination by exactly the amount', async () => {
    const source = await fundedAccount(app, '10000');
    const destination = await createAccount(app, { currency: 'USD' });

    await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '3000',
    });

    expect(await balanceOf(app, source)).toBe(7000n);
    expect(await balanceOf(app, destination.id)).toBe(3000n);
  });

  it('leaves total system value unchanged after an internal transfer', async () => {
    const source = await fundedAccount(app, '10000');
    const destination = await createAccount(app, { currency: 'USD' });
    const before = await totalSystemValue();

    await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '4200',
    });

    expect(await totalSystemValue()).toBe(before);
  });

  it('rejects an overdrawing transfer and writes no partial entries', async () => {
    const source = await fundedAccount(app, '1000');
    const destination = await createAccount(app, { currency: 'USD' });

    const { statusCode, body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '5000',
    });
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('insufficient_funds');

    // Full rollback: no transfer txn, no entries, no idempotency record, balances intact.
    const txns = await testDb()
      .selectFrom('ledger_transactions')
      .select(sql<number>`count(*)`.as('n'))
      .where('type', '=', 'transfer')
      .executeTakeFirstOrThrow();
    expect(Number(txns.n)).toBe(0);

    const idem = await testDb()
      .selectFrom('idempotency_records')
      .select(sql<number>`count(*)`.as('n'))
      .where('scope', '=', 'transfer')
      .executeTakeFirstOrThrow();
    expect(Number(idem.n)).toBe(0);

    expect(await balanceOf(app, source)).toBe(1000n);
    expect(await balanceOf(app, destination.id)).toBe(0n);
  });

  it('rejects a transfer from a frozen account', async () => {
    const source = await fundedAccount(app, '10000');
    const destination = await createAccount(app, { currency: 'USD' });
    await testDb()
      .updateTable('accounts')
      .set({ status: 'frozen' })
      .where('id', '=', source)
      .execute();

    const { statusCode, body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '100',
    });
    expect(statusCode).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('account_not_active');
  });

  it('rejects a transfer between accounts of different currencies', async () => {
    const source = await fundedAccount(app, '10000', 'USD');
    const destination = await createAccount(app, { currency: 'EUR' });

    const { statusCode, body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '100',
      currency: 'USD',
    });
    expect(statusCode).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('currency_mismatch');
  });

  it('rejects a transfer to the same account', async () => {
    const source = await fundedAccount(app, '10000');
    const { statusCode, body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: source,
      amount: '100',
    });
    expect(statusCode).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('same_account');
  });

  it('exposes a transfer by id with its entries', async () => {
    const source = await fundedAccount(app, '10000');
    const destination = await createAccount(app, { currency: 'USD' });
    const { body } = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination.id,
      amount: '1234',
    });
    const id = (body as { transfer: { id: string } }).transfer.id;

    const res = await app.inject({ method: 'GET', url: `/v1/transfers/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ transfer: { entries: unknown[] } }>().transfer.entries).toHaveLength(2);
  });

  it('the deferred DB trigger rejects an unbalanced ledger transaction at commit', async () => {
    const a = await fundedAccount(app, '10000');
    const b = (await createAccount(app, { currency: 'USD' })).id;

    await expect(
      testDb()
        .transaction()
        .execute(async (trx) => {
          const txn = await trx
            .insertInto('ledger_transactions')
            .values({ type: 'transfer', metadata: '{}' })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('ledger_entries')
            .values({
              ledger_transaction_id: txn.id,
              account_id: a,
              direction: 'debit',
              amount_minor: 100n,
              balance_after: 9900n,
              currency: 'USD',
            })
            .execute();
          await trx
            .insertInto('ledger_entries')
            .values({
              ledger_transaction_id: txn.id,
              account_id: b,
              direction: 'credit',
              amount_minor: 999n, // deliberately unbalanced
              balance_after: 999n,
              currency: 'USD',
            })
            .execute();
        }),
    ).rejects.toThrow();
  });
});
