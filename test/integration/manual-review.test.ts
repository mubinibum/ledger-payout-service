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
import { postWebhook } from '../helpers/webhook.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { processPayoutJob } from '../../src/modules/payouts/payout.worker.js';

const OP = { reason: 'operator confirmed with provider dashboard', operatorReference: 'ops-42' };

describe('integration: manual review resolution', () => {
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
    provider.reset();
    await resetDb();
  });

  /** A payout in `manual_review`, funds reserved, provider_contact set. */
  async function stuck(
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
    await stack.services.payouts.markManualReview(id, 'ambiguous_unresolved');
    expect((await getPayoutRow(id)).status).toBe('manual_review');
    return { id, source };
  }

  it('a manual_review payout cannot be cancelled through the public API', async () => {
    const { id } = await stuck('po-mr-cancel');
    const res = await stack.app.inject({ method: 'POST', url: `/v1/payouts/${id}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('payout_not_cancellable');
    expect((await getPayoutRow(id)).status).toBe('manual_review');
  });

  it('resolve-succeeded settles holding → clearing exactly once', async () => {
    const { id } = await stuck('po-mr-ok');
    const r = await stack.services.manualReview.resolveSucceeded(id, OP);
    expect(r.effect).toBe('applied');
    expect(r.payout.status).toBe('succeeded');

    const row = await getPayoutRow(id);
    expect(row.definitive_outcome_source).toBe('manual');
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await systemBalance('provider_clearing')).toBe(20000n);
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    await assertAllLedgerBalanced();

    const audit = await testDb()
      .selectFrom('payout_resolutions')
      .selectAll()
      .where('payout_id', '=', id)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resolution: 'succeeded', operator_reference: 'ops-42' });
    expect(audit[0]?.resulting_ledger_transaction_id).toBe(row.settlement_ledger_transaction_id);
  });

  it('resolve-failed releases holding → source exactly once', async () => {
    const { id, source } = await stuck('po-mr-fail');
    const r = await stack.services.manualReview.resolveFailed(id, OP);
    expect(r.effect).toBe('applied');
    expect(r.payout.status).toBe('failed');
    expect(await accountBalance(source)).toBe(100000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
    expect(await countLedgerByType('payout_release')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('a duplicate manual resolution is a no-op (no second effect)', async () => {
    const { id } = await stuck('po-mr-dup');
    await stack.services.manualReview.resolveSucceeded(id, OP);
    const second = await stack.services.manualReview.resolveSucceeded(id, OP);
    expect(second.effect).toBe('noop');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
  });

  it('a contradictory manual resolution is rejected, no second effect, audit recorded', async () => {
    const { id } = await stuck('po-mr-contra');
    await stack.services.manualReview.resolveSucceeded(id, OP);

    await expect(stack.services.manualReview.resolveFailed(id, OP)).rejects.toMatchObject({
      code: 'contradictory_resolution',
    });
    expect(await countLedgerByType('payout_release')).toBe(0);
    expect(await countLedgerByType('payout_settlement')).toBe(1);

    const audit = await testDb()
      .selectFrom('payout_resolutions')
      .selectAll()
      .where('payout_id', '=', id)
      .orderBy('created_at', 'asc')
      .execute();
    expect(audit.map((a) => a.resolution)).toEqual(['succeeded', 'rejected']);
  });

  it('manual_review + a definitive success webhook race → exactly one settlement', async () => {
    const { id } = await stuck('po-mr-race-ok');
    const [, webhookRes] = await Promise.all([
      stack.services.manualReview.resolveSucceeded(id, OP).catch(() => undefined),
      postWebhook(stack.app, {
        eventId: 'evt-mr-race-ok',
        type: 'payout.succeeded',
        idempotencyKey: 'po-mr-race-ok',
      }),
    ]);
    expect(webhookRes.statusCode).toBe(200);
    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
  });

  it('manual_review + a definitive failure webhook race → exactly one release', async () => {
    const { id, source } = await stuck('po-mr-race-fail');
    await Promise.all([
      stack.services.manualReview.resolveFailed(id, OP).catch(() => undefined),
      postWebhook(stack.app, {
        eventId: 'evt-mr-race-fail',
        type: 'payout.failed',
        idempotencyKey: 'po-mr-race-fail',
        failureCategory: 'permanent_rejection',
      }).catch(() => undefined),
    ]);
    expect((await getPayoutRow(id)).status).toBe('failed');
    expect(await countLedgerByType('payout_release')).toBe(1);
    expect(await accountBalance(source)).toBe(100000n);
  });

  it('manual resolution + reconciliation race → one accounting effect', async () => {
    const { ReconciliationService } =
      await import('../../src/modules/payouts/reconciliation.service.js');
    const { id } = await stuck('po-mr-rec-race');
    // put it back to submitted so reconciliation can claim it, then age it
    await stack.services.manualReview.resumeReconciliation(id, OP);
    await testDb()
      .updateTable('payouts')
      .set({ updated_at: new Date(Date.now() - 60_000), next_reconcile_at: null })
      .where('id', '=', id)
      .execute();
    provider.onStatus('po-mr-rec-race', { kind: 'succeeded', providerPayoutId: 'mpp-x' });
    const reconcile = new ReconciliationService(getDb(), stack.services.payouts, provider);

    await Promise.all([
      reconcile.reconcileOnce(),
      stack.services.payouts.applyProviderSuccess(id, { source: 'webhook' }).catch(() => undefined),
      reconcile.reconcileOnce(),
    ]);

    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_settlement')).toBe(1);
  });

  it('resume-reconcile moves manual_review → submitted with a fresh budget', async () => {
    const { id } = await stuck('po-mr-resume');
    await testDb()
      .updateTable('payouts')
      .set({ reconcile_attempt_count: 9 })
      .where('id', '=', id)
      .execute();
    const r = await stack.services.manualReview.resumeReconciliation(id, OP);
    expect(r.payout.status).toBe('submitted');
    const row = await getPayoutRow(id);
    expect(row.reconcile_attempt_count).toBe(0);
    expect(row.manual_review_reason).toBeNull();
  });

  it('inspect returns a summary and the audit trail, no sensitive fields', async () => {
    const { id } = await stuck('po-mr-inspect');
    await stack.services.manualReview.resolveSucceeded(id, OP);
    const info = await stack.services.manualReview.inspect(id);
    expect(info.payout.status).toBe('succeeded');
    expect(info.resolutions).toHaveLength(1);
    expect(JSON.stringify(info)).not.toMatch(/secret|password|signature/i);
  });
});
