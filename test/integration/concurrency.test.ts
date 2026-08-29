import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { startApp, stopApp } from '../helpers/app.js';
import { assertAllTransactionsBalanced, resetDb, testDb, totalSystemValue } from '../helpers/pg.js';
import { createAccount, fundAccount, transfer } from '../helpers/factories.js';

/**
 * The invariant test. It runs real HTTP requests against a real PostgreSQL database with
 * high parallelism — no mocked repositories. 100 concurrent transfers is the headline
 * case and is kept even though it is slow; the timeout below is generous on purpose so a
 * slow CI machine does not flake, while a genuine hang (deadlock, lost wakeup) still fails.
 */
const TIMEOUT_MS = 60_000;

async function balanceOf(id: string): Promise<bigint> {
  const row = await testDb()
    .selectFrom('accounts')
    .select('balance_minor')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.balance_minor;
}

async function transferTxnCount(): Promise<number> {
  const row = await testDb()
    .selectFrom('ledger_transactions')
    .select(sql<number>`count(*)`.as('n'))
    .where('type', '=', 'transfer')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

describe('integration: concurrency invariants', () => {
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

  it(
    '100+ parallel transfers: no negative balance, no lost update, value conserved',
    async () => {
      const CAPACITY = 100;
      const ATTEMPTS = 150;
      const AMOUNT = 100n;

      const source = await createAccount(app, { currency: 'USD' });
      const destination = await createAccount(app, { currency: 'USD' });
      await fundAccount(app, source.id, String(AMOUNT * BigInt(CAPACITY)));

      const valueBefore = await totalSystemValue();

      const results = await Promise.all(
        Array.from({ length: ATTEMPTS }, (_, i) =>
          transfer(app, {
            sourceAccountId: source.id,
            destinationAccountId: destination.id,
            amount: String(AMOUNT),
            idempotencyKey: `conc-${i}`,
          }),
        ),
      );

      const succeeded = results.filter((r) => r.statusCode === 201).length;
      const insufficient = results.filter(
        (r) =>
          r.statusCode === 422 &&
          (r.body as { error?: { code?: string } }).error?.code === 'insufficient_funds',
      ).length;

      expect(succeeded).toBe(CAPACITY);
      expect(insufficient).toBe(ATTEMPTS - CAPACITY);

      expect(await balanceOf(source.id)).toBe(0n);
      expect(await balanceOf(destination.id)).toBe(AMOUNT * BigInt(CAPACITY));
      expect(await balanceOf(source.id)).toBeGreaterThanOrEqual(0n);

      expect(await totalSystemValue()).toBe(valueBefore);
      expect(await transferTxnCount()).toBe(CAPACITY);
      await assertAllTransactionsBalanced();
    },
    TIMEOUT_MS,
  );

  it(
    'bidirectional transfers between the same pair do not deadlock',
    async () => {
      const a = await createAccount(app, { currency: 'USD' });
      const b = await createAccount(app, { currency: 'USD' });
      await fundAccount(app, a.id, '100000');
      await fundAccount(app, b.id, '100000');
      const valueBefore = await totalSystemValue();

      const jobs = Array.from({ length: 120 }, (_, i) => {
        const forward = i % 2 === 0;
        return transfer(app, {
          sourceAccountId: forward ? a.id : b.id,
          destinationAccountId: forward ? b.id : a.id,
          amount: '10',
          idempotencyKey: `bidi-${i}`,
        });
      });

      const results = await Promise.all(jobs);
      expect(results.every((r) => r.statusCode === 201)).toBe(true);

      // Equal traffic both ways and equal opening balances → balances unchanged.
      expect(await balanceOf(a.id)).toBe(100000n);
      expect(await balanceOf(b.id)).toBe(100000n);
      expect(await totalSystemValue()).toBe(valueBefore);
      await assertAllTransactionsBalanced();
    },
    TIMEOUT_MS,
  );

  it(
    'a reused idempotency key under load never produces a duplicate transfer',
    async () => {
      const source = await createAccount(app, { currency: 'USD' });
      const destination = await createAccount(app, { currency: 'USD' });
      await fundAccount(app, source.id, '100000');

      const KEYS = 10;
      const DUP = 12;
      const jobs = Array.from({ length: KEYS * DUP }, (_, i) =>
        transfer(app, {
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          amount: '100',
          idempotencyKey: `race-key-${i % KEYS}`,
        }),
      );

      const results = await Promise.all(jobs);
      expect(results.every((r) => r.statusCode === 201)).toBe(true);

      const ids = new Set(results.map((r) => (r.body as { transfer: { id: string } }).transfer.id));
      expect(ids.size).toBe(KEYS);
      expect(await transferTxnCount()).toBe(KEYS);
      expect(await balanceOf(destination.id)).toBe(100n * BigInt(KEYS));
      await assertAllTransactionsBalanced();
    },
    TIMEOUT_MS,
  );
});
