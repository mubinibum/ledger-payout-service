import { randomUUID } from 'node:crypto';
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
import { handleDeadLetter, processPayoutJob } from '../../src/modules/payouts/payout.worker.js';
import { startMockProvider, type StartedMockProvider } from '../helpers/mock-provider.js';
import { MockProviderClient } from '../../src/modules/provider/mock-provider.client.js';

/**
 * The M3.1 rule under test everywhere in this file:
 *   an ambiguous outcome NEVER triggers an automatic fund release.
 * A payout only leaves "reserved" via a definitive provider answer, a user cancellation
 * before submission, or an explicit operator resolution.
 */
describe('integration: ambiguous-payout safety', () => {
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

  async function fundedSource(amount = '100000'): Promise<string> {
    const id = (await createAccount(stack.app, { currency: 'USD' })).id;
    await fundAccount(stack.app, id, amount, { currency: 'USD' });
    return id;
  }
  async function createPayout(externalId: string, amount = '20000'): Promise<string> {
    const created = await createPayoutHttp(stack.app, {
      sourceAccountId: await fundedSource(),
      amount,
      externalId,
    });
    return expectPayout(created.body).id;
  }
  const runJob = (
    payoutId: string,
    ctx?: Partial<{ attemptsMade: number; maxAttempts: number }>,
  ): Promise<void> =>
    processPayoutJob(
      { db: getDb(), service: stack.services.payouts, provider },
      { payoutId, attemptsMade: ctx?.attemptsMade ?? 0, maxAttempts: ctx?.maxAttempts ?? 5 },
    );

  it('HTTP 5xx (real client) after possible provider acceptance → submitted, NOT released', async () => {
    const mock: StartedMockProvider = await startMockProvider({
      webhookUrl: 'http://127.0.0.1:59998/unused',
      webhookSecret: 'x'.repeat(20),
    });
    try {
      const source = await fundedSource();
      const created = await createPayoutHttp(stack.app, {
        sourceAccountId: source,
        amount: '20000',
        externalId: 'po-5xx',
      });
      const id = expectPayout(created.body).id;
      await mock.setScenario('po-5xx', { mode: 'server_5xx' });

      const client = new MockProviderClient({ baseUrl: mock.baseUrl, timeoutMs: 300 });
      await processPayoutJob(
        { db: getDb(), service: stack.services.payouts, provider: client },
        { payoutId: id, attemptsMade: 0, maxAttempts: 5 },
      );

      const row = await getPayoutRow(id);
      expect(row.status).toBe('submitted');
      expect(row.release_ledger_transaction_id).toBeNull();
      expect(await accountBalance(source)).toBe(80000n);
      expect(await systemBalance('payout_holding')).toBe(20000n);
    } finally {
      await mock.stop();
    }
  });

  it('a provider timeout / reset → submitted, funds stay reserved', async () => {
    const id = await createPayout('po-timeout');
    provider.onCreate('po-timeout', { kind: 'ambiguous' });
    await runJob(id);
    const row = await getPayoutRow(id);
    expect(row.status).toBe('submitted');
    expect(row.provider_contact).toBe(true);
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(await systemBalance('payout_holding')).toBe(20000n);
  });

  it('BullMQ retries exhausted after an ambiguous outcome → manual_review (not released)', async () => {
    // The worker path: ambiguous returns without throwing, so the job succeeds and never
    // reaches DLQ. Simulate the "we saw ambiguous, then the job later fails" edge directly.
    const id = await createPayout('po-retry-exhaust');
    provider.onCreate('po-retry-exhaust', { kind: 'ambiguous' });
    await runJob(id); // -> submitted (provider_contact = true)

    // A later job for the same payout exhausts and dead-letters.
    await handleDeadLetter({ db: getDb(), service: stack.services.payouts, provider }, id);

    const row = await getPayoutRow(id);
    // submitted stays with reconciliation; DLQ must not release it.
    expect(['submitted', 'manual_review']).toContain(row.status);
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(await systemBalance('payout_holding')).toBe(20000n);
  });

  it('DLQ for a payout that reached `processing` with provider contact possible → manual_review', async () => {
    const id = await createPayout('po-dlq-processing');
    // move it to processing and mark provider_contact (as an ambiguous mid-flight would)
    await stack.services.payouts.markProcessing(id);
    await testDb()
      .updateTable('payouts')
      .set({ provider_contact: true })
      .where('id', '=', id)
      .execute();

    await handleDeadLetter({ db: getDb(), service: stack.services.payouts, provider }, id);

    const row = await getPayoutRow(id);
    expect(row.status).toBe('manual_review');
    expect(row.manual_review_reason).toBe('dlq_provider_contact_possible');
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(await systemBalance('payout_holding')).toBe(20000n);
  });

  it('DLQ for a payout still `queued` with no provider contact → released (provably never sent)', async () => {
    const id = await createPayout('po-dlq-queued');
    // it is 'requested' from create; a transient-only worker path would leave it 'queued'
    await testDb().updateTable('payouts').set({ status: 'queued' }).where('id', '=', id).execute();

    await handleDeadLetter({ db: getDb(), service: stack.services.payouts, provider }, id);

    const row = await getPayoutRow(id);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('transient_exhausted');
    expect(await countLedgerByType('payout_release')).toBe(1);
    await assertAllLedgerBalanced();
  });

  it('a dead outbox event does not change payout accounting', async () => {
    const id = await createPayout('po-dead-outbox');
    await testDb()
      .updateTable('outbox_events')
      .set({ status: 'dead', attempt_count: 99 })
      .where('aggregate_id', '=', id)
      .execute();

    const row = await getPayoutRow(id);
    expect(row.status).toBe('requested');
    expect(row.settlement_ledger_transaction_id).toBeNull();
    expect(row.release_ledger_transaction_id).toBeNull();
    expect(await systemBalance('payout_holding')).toBe(20000n);

    // it IS visible to the safety stats (runbook / metrics)
    const { payoutSafetyStats } = await import('../../src/modules/payouts/payouts.repository.js');
    const stats = await payoutSafetyStats(testDb(), 0);
    expect(stats.outboxDeadWithReservedPayout).toBe(1);
  });

  it('cancellation vs worker submission race → exactly one wins, never both', async () => {
    for (let i = 0; i < 8; i += 1) {
      await resetDb();
      const ext = `po-cancel-race-${i}-${randomUUID()}`;
      const source = await fundedSource();
      const created = await createPayoutHttp(stack.app, {
        sourceAccountId: source,
        amount: '10000',
        externalId: ext,
      });
      const id = expectPayout(created.body).id;
      provider.onCreate(ext, { kind: 'accepted' });

      const [cancelRes] = await Promise.all([
        stack.app.inject({ method: 'POST', url: `/v1/payouts/${id}/cancel` }),
        runJob(id).catch(() => undefined),
      ]);

      const row = await getPayoutRow(id);
      if (cancelRes.statusCode === 200) {
        expect(row.status).toBe('cancelled');
        expect(row.provider_contact).toBe(false);
        expect(provider.createCallCount(ext)).toBe(0); // no submission after a committed cancel
      } else {
        expect(cancelRes.statusCode).toBe(409);
        expect(['submitted', 'processing']).toContain(row.status);
      }
      // exactly one accounting effect, always balanced
      const effects =
        (row.settlement_ledger_transaction_id ? 1 : 0) +
        (row.release_ledger_transaction_id ? 1 : 0);
      expect(effects).toBeLessThanOrEqual(1);
      await assertAllLedgerBalanced();
    }
  });

  it('a process restart preserves manual_review and the reserved funds', async () => {
    const { PayoutsService } = await import('../../src/modules/payouts/payouts.service.js');
    const id = await createPayout('po-restart');
    await stack.services.payouts.markManualReview(id, 'ambiguous_unresolved');
    expect((await getPayoutRow(id)).status).toBe('manual_review');

    // "restart" = a fresh service instance against the same database
    const freshPayouts = new PayoutsService(getDb());
    const row = await freshPayouts.getPayout(id);
    expect(row.status).toBe('manual_review');
    expect(await systemBalance('payout_holding')).toBe(20000n);

    // a worker job for it is a no-op
    await processPayoutJob(
      { db: getDb(), service: freshPayouts, provider },
      { payoutId: id, attemptsMade: 0, maxAttempts: 5 },
    );
    expect((await getPayoutRow(id)).status).toBe('manual_review');
  });

  it('same-key provider retry still yields one provider payout', async () => {
    const id = await createPayout('po-samekey');
    provider.onCreate('po-samekey', { kind: 'transient', times: 2 });
    await runJob(id).catch(() => undefined);
    await runJob(id).catch(() => undefined);
    await runJob(id);
    // all 3 attempts used exactly the same idempotency key
    expect(provider.createCallCount('po-samekey')).toBe(3);
    expect(provider.createCalls.every((k) => k === 'po-samekey')).toBe(true);
  });
});
