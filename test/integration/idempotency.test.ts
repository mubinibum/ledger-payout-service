import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { startApp, stopApp } from '../helpers/app.js';
import { closeDb } from '../../src/infra/db.js';
import { resetDb, testDb } from '../helpers/pg.js';
import { createAccount, fundAccount, transfer } from '../helpers/factories.js';

async function transferTxnCount(): Promise<number> {
  const row = await testDb()
    .selectFrom('ledger_transactions')
    .select(sql<number>`count(*)`.as('n'))
    .where('type', '=', 'transfer')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function pair(app: FastifyInstance): Promise<{ source: string; destination: string }> {
  const source = await createAccount(app, { currency: 'USD' });
  await fundAccount(app, source.id, '100000');
  const destination = await createAccount(app, { currency: 'USD' });
  return { source: source.id, destination: destination.id };
}

describe('integration: idempotency', () => {
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

  it('replays the first result for a repeated key + identical payload (one transfer only)', async () => {
    const { source, destination } = await pair(app);
    const key = 'idem-repeat-1';

    const first = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '5000',
      idempotencyKey: key,
    });
    const second = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '5000',
      idempotencyKey: key,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.body as { transfer: { id: string } }).transfer.id).toBe(
      (first.body as { transfer: { id: string } }).transfer.id,
    );
    expect(await transferTxnCount()).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/v1/accounts/${source}` });
    expect(detail.json<{ account: { balanceMinor: string } }>().account.balanceMinor).toBe('95000');
  });

  it('returns 409 for the same key with a different payload', async () => {
    const { source, destination } = await pair(app);
    const key = 'idem-conflict-1';

    await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '5000',
      idempotencyKey: key,
    });
    const conflicting = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '9999',
      idempotencyKey: key,
    });

    expect(conflicting.statusCode).toBe(409);
    expect((conflicting.body as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict',
    );
    expect(await transferTxnCount()).toBe(1);
  });

  it('collapses many parallel requests with the same key to a single transfer', async () => {
    const { source, destination } = await pair(app);
    const key = 'idem-parallel-1';

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        transfer(app, {
          sourceAccountId: source,
          destinationAccountId: destination,
          amount: '1000',
          idempotencyKey: key,
        }),
      ),
    );

    const ok = results.filter((r) => r.statusCode === 201);
    const ids = new Set(ok.map((r) => (r.body as { transfer: { id: string } }).transfer.id));
    expect(ids.size).toBe(1);
    expect(await transferTxnCount()).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/v1/accounts/${source}` });
    expect(detail.json<{ account: { balanceMinor: string } }>().account.balanceMinor).toBe('99000');
  });

  it('does not store a record when the request fails validation', async () => {
    const { source, destination } = await pair(app);
    const key = 'idem-badreq-1';

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': key },
      payload: { sourceAccountId: source, destinationAccountId: destination, currency: 'USD' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '2000',
      idempotencyKey: key,
    });
    expect(good.statusCode).toBe(201);
    expect(await transferTxnCount()).toBe(1);
  });

  it('replays from the committed record after a process restart', async () => {
    const { source, destination } = await pair(app);
    const key = 'idem-restart-1';

    const first = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '7000',
      idempotencyKey: key,
    });
    const firstId = (first.body as { transfer: { id: string } }).transfer.id;

    // Simulate a restart: tear down the app + its DB pool, build a fresh one.
    await app.close();
    await closeDb();
    app = await startApp();

    const replay = await transfer(app, {
      sourceAccountId: source,
      destinationAccountId: destination,
      amount: '7000',
      idempotencyKey: key,
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.body as { transfer: { id: string } }).transfer.id).toBe(firstId);
    expect(await transferTxnCount()).toBe(1);
  });
});
