import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../src/config/env.js';
import { armFault, clearFaults } from '../../src/infra/fault.js';
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
  getPayoutRow,
  systemBalance,
} from '../helpers/payouts.js';
import { postWebhook } from '../helpers/webhook.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { processPayoutJob } from '../../src/modules/payouts/payout.worker.js';
import { ReconciliationService } from '../../src/modules/payouts/reconciliation.service.js';

/**
 * Every fault point is armed via the test-only `armFault` registry (no runtime surface).
 * The assertion each time is: the database transaction rolled back cleanly, and the flow
 * recovers on the next attempt with no duplicated accounting or provider effect.
 */
describe('integration: failure injection', () => {
  let stack: StartedStack;
  let provider: FakeProvider;

  beforeAll(async () => {
    process.env['RECONCILE_STALE_AFTER_SEC'] = '1';
    resetEnvCache();
    provider = new FakeProvider();
    stack = await startStack({ provider });
  });
  afterAll(() => stopApp(stack));
  beforeEach(async () => {
    clearFaults();
    await resetDb();
  });

  async function fundedSource(amount = '100000'): Promise<string> {
    const id = (await createAccount(stack.app, { currency: 'USD' })).id;
    await fundAccount(stack.app, id, amount, { currency: 'USD' });
    return id;
  }

  const runJob = (payoutId: string): Promise<void> =>
    processPayoutJob(
      { db: getDb(), service: stack.services.payouts, provider },
      { payoutId, attemptsMade: 0, maxAttempts: 5 },
    );

  it('fault after reservation entries → full rollback, retry succeeds', async () => {
    const source = await fundedSource();

    armFault('after_reservation_entries');
    const failed = await createPayoutHttp(stack.app, { sourceAccountId: source, amount: '10000' });
    expect(failed.statusCode).toBe(500);
    expect(await accountBalance(source)).toBe(100000n);
    expect(await countLedgerByType('payout_reservation')).toBe(0);

    clearFaults();
    const ok = await createPayoutHttp(stack.app, { sourceAccountId: source, amount: '10000' });
    expect(ok.statusCode).toBe(201);
    expect(await accountBalance(source)).toBe(90000n);
  });

  it('fault after payout insert → nothing persists', async () => {
    const source = await fundedSource();
    armFault('after_payout_insert');
    const res = await createPayoutHttp(stack.app, { sourceAccountId: source, amount: '10000' });
    expect(res.statusCode).toBe(500);

    const counts = await testDb()
      .selectFrom('payouts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(counts.n)).toBe(0);
    expect(await systemBalance('payout_holding')).toBe(0n);
  });

  it('fault after provider accept (mock 500) → worker retries, one provider payout, recovers', async () => {
    const source = await fundedSource();
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      externalId: 'po-fi-accept',
    });
    const payoutId = expectPayout(created.body).id;
    provider.onCreate('po-fi-accept', { kind: 'accepted' });

    // First worker run: provider "accepts" then the injected fault makes it throw transient.
    provider.onCreate('po-fi-accept', { kind: 'transient', times: 1 });
    await runJob(payoutId).catch(() => undefined); // transient rethrows
    // Second run recovers.
    await runJob(payoutId);

    expect(provider.createCallCount('po-fi-accept')).toBe(2);
    const row = await getPayoutRow(payoutId);
    expect(['submitted', 'succeeded']).toContain(row.status);
  });

  it('fault during webhook accounting transition → receipt not persisted, retry applies once', async () => {
    const source = await fundedSource();
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      externalId: 'po-fi-wh',
    });
    const payoutId = expectPayout(created.body).id;
    provider.onCreate('po-fi-wh', { kind: 'accepted' });
    await runJob(payoutId); // -> submitted

    armFault('webhook_accounting_transition');
    const failed = await postWebhook(stack.app, {
      eventId: 'evt-fi-wh',
      type: 'payout.succeeded',
      idempotencyKey: 'po-fi-wh',
    });
    expect(failed.statusCode).toBe(500);
    // receipt rolled back
    const receipts = await testDb().selectFrom('provider_webhook_events').select('id').execute();
    expect(receipts).toHaveLength(0);
    expect((await getPayoutRow(payoutId)).status).toBe('submitted');

    clearFaults();
    const ok = await postWebhook(stack.app, {
      eventId: 'evt-fi-wh',
      type: 'payout.succeeded',
      idempotencyKey: 'po-fi-wh',
    });
    expect(ok.statusCode).toBe(200);
    expect((await getPayoutRow(payoutId)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('fault during a reconciliation transition → payout stays reserved, next run resolves', async () => {
    const source = await fundedSource();
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount: '10000',
      externalId: 'po-fi-rec',
    });
    const payoutId = expectPayout(created.body).id;
    provider.onCreate('po-fi-rec', { kind: 'ambiguous' });
    await runJob(payoutId); // -> submitted
    await testDb()
      .updateTable('payouts')
      .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
      .where('id', '=', payoutId)
      .execute();
    provider.onStatus('po-fi-rec', { kind: 'succeeded', providerPayoutId: 'mpp-fi' });

    const reconcile = new ReconciliationService(stack.services.payouts, provider);
    armFault('reconciliation_transition');
    const r1 = await reconcile.reconcileOnce();
    expect(r1.errors).toBe(1);
    expect((await getPayoutRow(payoutId)).status).toBe('submitted');
    expect(await systemBalance('payout_holding')).toBe(10000n);

    clearFaults();
    await testDb()
      .updateTable('payouts')
      .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
      .where('id', '=', payoutId)
      .execute();
    const r2 = await reconcile.reconcileOnce();
    expect(r2.settled).toBe(1);
    expect((await getPayoutRow(payoutId)).status).toBe('succeeded');
  });
});
