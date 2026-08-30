import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../src/config/env.js';
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
import { FakeProvider } from '../helpers/fake-provider.js';
import { processPayoutJob } from '../../src/modules/payouts/payout.worker.js';
import { ReconciliationService } from '../../src/modules/payouts/reconciliation.service.js';

describe('integration: reconciliation', () => {
  let stack: StartedStack;
  let provider: FakeProvider;
  let reconcile: ReconciliationService;

  beforeAll(async () => {
    process.env['RECONCILE_STALE_AFTER_SEC'] = '1';
    process.env['RECONCILE_MAX_ATTEMPTS'] = '3';
    resetEnvCache();
    provider = new FakeProvider();
    stack = await startStack({ provider });
    reconcile = new ReconciliationService(stack.services.payouts, provider);
  });
  afterAll(() => stopApp(stack));
  beforeEach(async () => {
    await resetDb();
  });

  /** A payout that the worker moved to `submitted` (ambiguous), then aged past the threshold. */
  async function stuckSubmitted(
    externalId: string,
    amount = '20000',
  ): Promise<{ id: string; source: string }> {
    const source = (await createAccount(stack.app, { currency: 'USD' })).id;
    await fundAccount(stack.app, source, '100000', { currency: 'USD' });
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: source,
      amount,
      externalId,
    });
    const id = expectPayout(created.body).id;
    provider.onCreate(externalId, { kind: 'ambiguous' });
    await processPayoutJob(
      { db: getDb(), service: stack.services.payouts, provider },
      { payoutId: id, attemptsMade: 0, maxAttempts: 5 },
    );
    expect((await getPayoutRow(id)).status).toBe('submitted');
    // age it
    await testDb()
      .updateTable('payouts')
      .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
      .where('id', '=', id)
      .execute();
    return { id, source };
  }

  it('an ambiguous timeout never releases funds on its own', async () => {
    const { id, source } = await stuckSubmitted('po-rec-0');
    // immediately after the ambiguous outcome, before reconciliation:
    expect(await accountBalance(source)).toBe(80000n);
    expect(await systemBalance('payout_holding')).toBe(20000n);
    const row = await getPayoutRow(id);
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(row.settlement_ledger_transaction_id).toBeNull();
  });

  it('reconciliation settles a payout the provider reports succeeded — once', async () => {
    const { id } = await stuckSubmitted('po-rec-1');
    provider.onStatus('po-rec-1', { kind: 'succeeded', providerPayoutId: 'mpp-1' });

    const a = await reconcile.reconcileOnce();
    expect(a.settled).toBe(1);
    const b = await reconcile.reconcileOnce(); // idempotent
    expect(b.settled).toBe(0);

    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('reconciliation releases a payout the provider reports failed — once', async () => {
    const { id, source } = await stuckSubmitted('po-rec-2');
    provider.onStatus('po-rec-2', {
      kind: 'failed',
      providerPayoutId: 'mpp-2',
      category: 'permanent_rejection',
    });

    await reconcile.reconcileOnce();
    await reconcile.reconcileOnce();

    expect((await getPayoutRow(id)).status).toBe('failed');
    expect(await accountBalance(source)).toBe(100000n);
    expect(await countLedgerByType('payout_release')).toBe(1);
  });

  it('a still-pending provider result keeps funds reserved and reschedules', async () => {
    const { id, source } = await stuckSubmitted('po-rec-3');
    provider.onStatus('po-rec-3', { kind: 'pending', providerPayoutId: 'mpp-3' });

    const r = await reconcile.reconcileOnce();
    expect(r.stillPending).toBe(1);

    const row = await getPayoutRow(id);
    expect(row.status).toBe('submitted');
    expect(row.reconcile_attempt_count).toBe(1);
    expect(row.next_reconcile_at).not.toBeNull();
    expect(await systemBalance('payout_holding')).toBe(20000n);
    expect(await accountBalance(source)).toBe(80000n);
  });

  it('an unknown provider result eventually releases after RECONCILE_MAX_ATTEMPTS', async () => {
    const { id, source } = await stuckSubmitted('po-rec-4');
    provider.onStatus('po-rec-4', { kind: 'unknown' });

    for (let i = 0; i < 4; i += 1) {
      await reconcile.reconcileOnce();
      await testDb()
        .updateTable('payouts')
        .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
        .where('id', '=', id)
        .execute();
    }

    const row = await getPayoutRow(id);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('reconciliation_not_found');
    expect(await accountBalance(source)).toBe(100000n);
  });

  it('worker and reconciliation racing on the same payout do not double-apply', async () => {
    const { id } = await stuckSubmitted('po-rec-5');
    provider.onCreate('po-rec-5', { kind: 'succeeded' });
    provider.onStatus('po-rec-5', { kind: 'succeeded', providerPayoutId: 'mpp-5' });

    await Promise.all([
      reconcile.reconcileOnce(),
      stack.services.payouts.applyProviderSuccess(id, { source: 'worker' }),
      reconcile.reconcileOnce(),
    ]);

    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
  });
});
