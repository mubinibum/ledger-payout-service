import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startStack, stopApp, type StartedStack } from '../helpers/app.js';
import { resetDb, testDb } from '../helpers/pg.js';
import { createAccount, fundAccount } from '../helpers/factories.js';
import {
  accountBalance,
  assertAllLedgerBalanced,
  countLedgerByType,
  createPayoutHttp,
  expectPayout,
  getPayoutRow,
  systemBalance,
  totalSystemValue,
} from '../helpers/payouts.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { processPayoutJob } from '../../src/modules/payouts/payout.worker.js';
import { getDb } from '../../src/infra/db.js';

describe('integration: payouts — reservation, settlement, release, idempotency', () => {
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

  async function fundedSource(amount: string): Promise<string> {
    const acct = await createAccount(stack.app, { currency: 'USD' });
    await fundAccount(stack.app, acct.id, amount, { currency: 'USD' });
    return acct.id;
  }

  const runJob = (payoutId: string): Promise<void> =>
    processPayoutJob(
      { db: getDb(), service: stack.services.payouts, provider },
      { payoutId, attemptsMade: 0, maxAttempts: 5 },
    );

  it('create reserves funds with a balanced 2-entry ledger transaction', async () => {
    const source = await fundedSource('100000');
    const { statusCode, body } = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '25000',
    });
    expect(statusCode).toBe(201);
    const payout = expectPayout(body);
    expect(payout.status).toBe('requested');

    expect(await accountBalance(source)).toBe(75000n);
    expect(await systemBalance('payout_holding')).toBe(25000n);
    expect(await countLedgerByType('payout_reservation')).toBe(1);
    await assertAllLedgerBalanced();

    // outbox event written atomically with the reservation
    const outbox = await testDb().selectFrom('outbox_events').selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_type).toBe('payout.requested');
    expect(outbox[0]?.status).toBe('pending');
  });

  it('insufficient funds → no payout, no entries, no outbox', async () => {
    const source = await fundedSource('1000');
    const { statusCode, body } = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '5000',
    });
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('insufficient_funds');

    expect(await accountBalance(source)).toBe(1000n);
    const counts = await testDb()
      .selectFrom('payouts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(counts.n)).toBe(0);
    const outbox = await testDb().selectFrom('outbox_events').select('id').execute();
    expect(outbox).toHaveLength(0);
  });

  it('idempotency replay → one payout and one reservation', async () => {
    const source = await fundedSource('100000');
    const first = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      idempotencyKey: 'pk-replay',
    });
    const second = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      idempotencyKey: 'pk-replay',
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(expectPayout(second.body).id).toBe(expectPayout(first.body).id);
    expect(await countLedgerByType('payout_reservation')).toBe(1);
    expect(await accountBalance(source)).toBe(90000n);
  });

  it('idempotency conflict (same key, different amount) → 409', async () => {
    const source = await fundedSource('100000');
    await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      idempotencyKey: 'pk-conflict',
    });
    const conflicting = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '20000',
      idempotencyKey: 'pk-conflict',
    });
    expect(conflicting.statusCode).toBe(409);
    expect((conflicting.body as { error: { code: string } }).error.code).toBe(
      'idempotency_conflict',
    );
  });

  it('parallel same-key requests → exactly one payout', async () => {
    const source = await fundedSource('100000');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createPayoutHttp(stack.app, {
          sourceAccountId: source,
          amount: '5000',
          idempotencyKey: 'pk-parallel',
        }),
      ),
    );
    const ids = new Set(
      results.filter((r) => r.statusCode === 201).map((r) => expectPayout(r.body).id),
    );
    expect(ids.size).toBe(1);
    expect(await countLedgerByType('payout_reservation')).toBe(1);
    expect(await accountBalance(source)).toBe(95000n);
  });

  it('provider success → settles holding → clearing exactly once; value conserved', async () => {
    const source = await fundedSource('100000');
    const before = await totalSystemValue();
    const created = await createPayoutHttp(stack.app, { sourceAccountId: source, amount: '30000' });
    const payoutId = expectPayout(created.body).id;

    await runJob(payoutId);
    await runJob(payoutId); // duplicate delivery — must be a no-op

    const row = await getPayoutRow(payoutId);
    expect(row.status).toBe('succeeded');
    expect(row.settlement_ledger_transaction_id).not.toBeNull();
    expect(row.release_ledger_transaction_id).toBeNull();

    expect(await accountBalance(source)).toBe(70000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await systemBalance('provider_clearing')).toBe(30000n);
    expect(await totalSystemValue()).toBe(before);
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('permanent provider rejection → releases holding → source exactly once', async () => {
    const source = await fundedSource('100000');
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '40000',
      externalId: 'po-perm-1',
    });
    const payoutId = expectPayout(created.body).id;
    provider.onCreate('po-perm-1', { kind: 'permanent', category: 'permanent_rejection' });

    await runJob(payoutId);
    await runJob(payoutId);

    const row = await getPayoutRow(payoutId);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('permanent_rejection');
    expect(row.release_ledger_transaction_id).not.toBeNull();
    expect(row.settlement_ledger_transaction_id).toBeNull();

    expect(await accountBalance(source)).toBe(100000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await countLedgerByType('payout_release')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('cancel before submission → releases funds once', async () => {
    const source = await fundedSource('100000');
    const created = await createPayoutHttp(stack.app, { sourceAccountId: source, amount: '15000' });
    const payoutId = expectPayout(created.body).id;

    const res = await stack.app.inject({ method: 'POST', url: `/v1/payouts/${payoutId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ payout: { status: string } }>().payout.status).toBe('cancelled');

    // cancel again — idempotent
    const again = await stack.app.inject({ method: 'POST', url: `/v1/payouts/${payoutId}/cancel` });
    expect(again.statusCode).toBe(200);

    expect(await accountBalance(source)).toBe(100000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await countLedgerByType('payout_release')).toBe(1);
  });

  it('cancel after the worker started → 409 payout_not_cancellable', async () => {
    const source = await fundedSource('100000');
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '15000',
      externalId: 'po-cancel-late',
    });
    const payoutId = expectPayout(created.body).id;
    provider.onCreate('po-cancel-late', { kind: 'accepted' });
    await runJob(payoutId); // -> submitted

    const res = await stack.app.inject({ method: 'POST', url: `/v1/payouts/${payoutId}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('payout_not_cancellable');
  });

  it('rollback after a simulated mid-transaction failure leaves nothing behind', async () => {
    const { armFault } = await import('../../src/infra/fault.js');
    const source = await fundedSource('100000');
    armFault('after_outbox_insert');

    const { statusCode } = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
    });
    expect(statusCode).toBe(500);

    expect(await accountBalance(source)).toBe(100000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await countLedgerByType('payout_reservation')).toBe(0);
    const payoutCount = await testDb()
      .selectFrom('payouts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const outboxCount = await testDb()
      .selectFrom('outbox_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(payoutCount.n)).toBe(0);
    expect(Number(outboxCount.n)).toBe(0);
  });
});
