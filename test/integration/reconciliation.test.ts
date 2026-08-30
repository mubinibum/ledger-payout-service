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

describe('integration: reconciliation (M3.1 policy — ambiguous never releases)', () => {
  let stack: StartedStack;
  let provider: FakeProvider;
  let reconcile: ReconciliationService;

  beforeAll(async () => {
    process.env['RECONCILE_STALE_AFTER_SEC'] = '1';
    process.env['RECONCILE_MAX_ATTEMPTS'] = '3';
    resetEnvCache();
    provider = new FakeProvider();
    stack = await startStack({ provider });
    reconcile = new ReconciliationService(getDb(), stack.services.payouts, provider);
  });
  afterAll(() => stopApp(stack));
  beforeEach(async () => {
    provider.setCapabilities({ notFoundIsDefinitive: false });
    await resetDb();
  });

  async function age(id: string): Promise<void> {
    await testDb()
      .updateTable('payouts')
      .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
      .where('id', '=', id)
      .execute();
  }

  /** A payout the worker moved to `submitted` (ambiguous), aged past the threshold. */
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
    await age(id);
    return { id, source };
  }

  it('an ambiguous outcome never releases funds on its own', async () => {
    const { id, source } = await stuckSubmitted('po-rec-0');
    expect(await accountBalance(source)).toBe(80000n);
    expect(await systemBalance('payout_holding')).toBe(20000n);
    const row = await getPayoutRow(id);
    expect(row.provider_contact).toBe(true);
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(row.settlement_ledger_transaction_id).toBeNull();
  });

  it('settles a payout the provider reports succeeded — once', async () => {
    const { id } = await stuckSubmitted('po-rec-1');
    provider.onStatus('po-rec-1', { kind: 'succeeded', providerPayoutId: 'mpp-1' });

    expect((await reconcile.reconcileOnce()).settled).toBe(1);
    expect((await reconcile.reconcileOnce()).settled).toBe(0); // idempotent

    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('releases a payout the provider reports definitively failed — once', async () => {
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
    expect(await systemBalance('payout_holding')).toBe(20000n);
    expect(await accountBalance(source)).toBe(80000n);
  });

  it('generic provider not_found → funds stay reserved, then manual_review at max attempts', async () => {
    const { id, source } = await stuckSubmitted('po-rec-4');
    provider.onStatus('po-rec-4', { kind: 'unknown' });

    for (let i = 0; i < 4; i += 1) {
      await reconcile.reconcileOnce();
      await age(id);
    }

    const row = await getPayoutRow(id);
    expect(row.status).toBe('manual_review');
    expect(row.manual_review_reason).toBe('reconciliation_exhausted');
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(await accountBalance(source)).toBe(80000n); // still reserved
    expect(await systemBalance('payout_holding')).toBe(20000n);
  });

  it('persistent pending → manual_review at max attempts, funds reserved', async () => {
    const { id, source } = await stuckSubmitted('po-rec-4b');
    provider.onStatus('po-rec-4b', { kind: 'pending', providerPayoutId: 'mpp-4b' });

    for (let i = 0; i < 4; i += 1) {
      await reconcile.reconcileOnce();
      await age(id);
    }
    const row = await getPayoutRow(id);
    expect(row.status).toBe('manual_review');
    expect(await accountBalance(source)).toBe(80000n);
  });

  it('only releases on not_found when the adapter declares it definitive', async () => {
    const { id, source } = await stuckSubmitted('po-rec-4c');
    provider.onStatus('po-rec-4c', { kind: 'unknown' });
    provider.setCapabilities({ notFoundIsDefinitive: true });

    await reconcile.reconcileOnce();

    const row = await getPayoutRow(id);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('definitive_not_found');
    expect(await accountBalance(source)).toBe(100000n);
  });

  it('a malformed provider status → manual_review after the retry budget, never released', async () => {
    const { id, source } = await stuckSubmitted('po-rec-4d');
    // FakeProvider throwing from getPayoutStatus simulates an unparseable / broken status.
    provider.onStatus('po-rec-4d', { kind: 'succeeded', providerPayoutId: 'x' });
    const original = provider.getPayoutStatus.bind(provider);
    provider.getPayoutStatus = async (): Promise<never> => {
      throw new Error('unparseable provider response');
    };

    for (let i = 0; i < 4; i += 1) {
      await reconcile.reconcileOnce();
      await age(id);
    }
    provider.getPayoutStatus = original;

    const row = await getPayoutRow(id);
    expect(row.status).toBe('manual_review');
    expect(row.manual_review_reason).toBe('malformed_provider_status');
    expect(await accountBalance(source)).toBe(80000n);
  });

  it('worker and reconciliation racing on the same payout do not double-apply', async () => {
    const { id } = await stuckSubmitted('po-rec-5');
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
