import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/infra/db.js';
import { startStack, stopApp, type StartedStack } from '../helpers/app.js';
import { resetDb, testDb } from '../helpers/pg.js';
import { createAccount, fundAccount } from '../helpers/factories.js';
import {
  accountBalance,
  assertAllLedgerBalanced,
  countLedgerByType,
  createPayoutHttp,
  expectPayout,
  systemBalance,
  totalSystemValue,
} from '../helpers/payouts.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { processPayoutJob } from '../../src/modules/payouts/payout.worker.js';

const TIMEOUT_MS = 60_000;

describe('integration: payout concurrency invariants', () => {
  let stack: StartedStack;
  let provider: FakeProvider;

  beforeAll(async () => {
    provider = new FakeProvider();
    stack = await startStack({ provider });
  });
  afterAll(() => stopApp(stack));
  beforeEach(async () => {
    await resetDb();
  });

  it(
    '100+ parallel payouts on one source: capacity respected, no negative balance, value conserved',
    async () => {
      const CAPACITY = 100;
      const ATTEMPTS = 150;
      const AMOUNT = 100n;

      const source = (await createAccount(stack.app, { currency: 'USD' })).id;
      await fundAccount(stack.app, source, String(AMOUNT * BigInt(CAPACITY)), { currency: 'USD' });
      const valueBefore = await totalSystemValue();

      const results = await Promise.all(
        Array.from({ length: ATTEMPTS }, (_, i) =>
          createPayoutHttp(stack.app, {
            sourceAccountId: source,
            amount: String(AMOUNT),
            idempotencyKey: `pc-${i}`,
          }),
        ),
      );

      const reserved = results.filter((r) => r.statusCode === 201);
      const rejected = results.filter(
        (r) =>
          r.statusCode === 422 &&
          (r.body as { error?: { code?: string } }).error?.code === 'insufficient_funds',
      );
      expect(reserved).toHaveLength(CAPACITY);
      expect(rejected).toHaveLength(ATTEMPTS - CAPACITY);

      expect(await accountBalance(source)).toBe(0n);
      expect(await accountBalance(source)).toBeGreaterThanOrEqual(0n);
      expect(await systemBalance('payout_holding')).toBe(AMOUNT * BigInt(CAPACITY));
      expect(await totalSystemValue()).toBe(valueBefore);
      expect(await countLedgerByType('payout_reservation')).toBe(CAPACITY);
      await assertAllLedgerBalanced();

      // Now settle every reserved payout in parallel → holding drains to clearing.
      const ids = reserved.map((r) => expectPayout(r.body).id);
      await Promise.all(
        ids.map((id) =>
          processPayoutJob(
            { db: getDb(), service: stack.services.payouts, provider },
            { payoutId: id, attemptsMade: 0, maxAttempts: 5 },
          ),
        ),
      );

      expect(await systemBalance('payout_holding')).toBe(0n);
      expect(await systemBalance('provider_clearing')).toBe(AMOUNT * BigInt(CAPACITY));
      expect(await totalSystemValue()).toBe(valueBefore);
      expect(await countLedgerByType('payout_settlement')).toBe(CAPACITY);
      await assertAllLedgerBalanced();

      const payoutRows = await testDb().selectFrom('payouts').select('status').execute();
      expect(payoutRows.every((r) => r.status === 'succeeded')).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'a reused idempotency key under load never creates a second payout or reservation',
    async () => {
      const source = (await createAccount(stack.app, { currency: 'USD' })).id;
      await fundAccount(stack.app, source, '1000000', { currency: 'USD' });

      const KEYS = 10;
      const DUP = 12;
      const results = await Promise.all(
        Array.from({ length: KEYS * DUP }, (_, i) =>
          createPayoutHttp(stack.app, {
            sourceAccountId: source,
            amount: '1000',
            idempotencyKey: `pc-race-${i % KEYS}`,
          }),
        ),
      );

      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      const ids = new Set(results.map((r) => expectPayout(r.body).id));
      expect(ids.size).toBe(KEYS);
      expect(await countLedgerByType('payout_reservation')).toBe(KEYS);
      expect(await systemBalance('payout_holding')).toBe(1000n * BigInt(KEYS));
      await assertAllLedgerBalanced();
    },
    TIMEOUT_MS,
  );
});
