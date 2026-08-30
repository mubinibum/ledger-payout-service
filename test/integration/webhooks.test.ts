import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startStack, stopApp, type StartedStack } from '../helpers/app.js';
import { resetDb } from '../helpers/pg.js';
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
import { getDb } from '../../src/infra/db.js';

describe('integration: signed provider webhooks', () => {
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

  /** Create a payout and drive it to `submitted` (provider accepted, result pending). */
  async function submittedPayout(
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
    provider.onCreate(externalId, { kind: 'accepted' });
    await processPayoutJob(
      { db: getDb(), service: stack.services.payouts, provider },
      { payoutId: id, attemptsMade: 0, maxAttempts: 5 },
    );
    expect((await getPayoutRow(id)).status).toBe('submitted');
    return { id, source };
  }

  it('a valid signed success webhook settles the payout', async () => {
    const { id } = await submittedPayout('po-wh-1');
    const res = await postWebhook(stack.app, {
      eventId: 'evt-wh-1',
      type: 'payout.succeeded',
      idempotencyKey: 'po-wh-1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ received: true, result: 'applied_success' });
    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await systemBalance('provider_clearing')).toBe(20000n);
    await assertAllLedgerBalanced();
  });

  it('a valid signed failure webhook releases the payout', async () => {
    const { id, source } = await submittedPayout('po-wh-2');
    const res = await postWebhook(stack.app, {
      eventId: 'evt-wh-2',
      type: 'payout.failed',
      idempotencyKey: 'po-wh-2',
      failureCategory: 'permanent_rejection',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ result: 'applied_failure' });
    expect((await getPayoutRow(id)).status).toBe('failed');
    expect(await accountBalance(source)).toBe(100000n);
    expect(await systemBalance('payout_holding')).toBe(0n);
  });

  it('rejects an invalid signature (401), no state change', async () => {
    const { id } = await submittedPayout('po-wh-3');
    const res = await postWebhook(
      stack.app,
      { eventId: 'evt-wh-3', type: 'payout.succeeded', idempotencyKey: 'po-wh-3' },
      { tamperBody: true },
    );
    expect(res.statusCode).toBe(401);
    expect((await getPayoutRow(id)).status).toBe('submitted');
  });

  it('rejects a stale timestamp (401)', async () => {
    await submittedPayout('po-wh-4');
    const res = await postWebhook(
      stack.app,
      { eventId: 'evt-wh-4', type: 'payout.succeeded', idempotencyKey: 'po-wh-4' },
      { timestamp: Math.floor(Date.now() / 1000) - 4000 },
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'webhook_timestamp_invalid' } });
  });

  it('a duplicate event id replays the first result (one accounting effect)', async () => {
    const { id } = await submittedPayout('po-wh-5');
    const body = {
      eventId: 'evt-wh-5',
      type: 'payout.succeeded' as const,
      idempotencyKey: 'po-wh-5',
    };
    const first = await postWebhook(stack.app, body);
    const second = await postWebhook(stack.app, body);
    expect(first.body).toMatchObject({ replay: false });
    expect(second.body).toMatchObject({ replay: true });
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    expect((await getPayoutRow(id)).status).toBe('succeeded');
  });

  it('same event id with a different payload → 409', async () => {
    await submittedPayout('po-wh-6');
    await postWebhook(stack.app, {
      eventId: 'evt-wh-6',
      type: 'payout.succeeded',
      idempotencyKey: 'po-wh-6',
    });
    const res = await postWebhook(stack.app, {
      eventId: 'evt-wh-6',
      type: 'payout.failed',
      idempotencyKey: 'po-wh-6',
      failureCategory: 'permanent_rejection',
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'webhook_conflict' } });
  });

  it('concurrent duplicate webhooks apply the effect exactly once', async () => {
    const { id } = await submittedPayout('po-wh-7');
    const body = {
      eventId: 'evt-wh-7',
      type: 'payout.succeeded' as const,
      idempotencyKey: 'po-wh-7',
    };
    const results = await Promise.all([
      postWebhook(stack.app, body),
      postWebhook(stack.app, body),
      postWebhook(stack.app, body),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await countLedgerByType('payout_settlement')).toBe(1);
    expect((await getPayoutRow(id)).status).toBe('succeeded');
  });

  it('out-of-order: a failure webhook after success is a safe no-op (terminal wins)', async () => {
    const { id } = await submittedPayout('po-wh-8');
    await postWebhook(stack.app, {
      eventId: 'evt-wh-8a',
      type: 'payout.succeeded',
      idempotencyKey: 'po-wh-8',
    });
    const late = await postWebhook(stack.app, {
      eventId: 'evt-wh-8b',
      type: 'payout.failed',
      idempotencyKey: 'po-wh-8',
      failureCategory: 'permanent_rejection',
    });
    expect(late.statusCode).toBe(200);
    expect(late.body).toMatchObject({ result: 'noop_terminal' });
    expect((await getPayoutRow(id)).status).toBe('succeeded');
    expect(await countLedgerByType('payout_release')).toBe(0);
  });

  it('a success webhook after a reconciliation-driven failure is a safe no-op', async () => {
    const { id, source } = await submittedPayout('po-wh-9');
    // reconciliation-style release first
    await stack.services.payouts.applyProviderFailure(id, {
      category: 'reconciliation_not_found',
      source: 'reconciliation',
    });
    const res = await postWebhook(stack.app, {
      eventId: 'evt-wh-9',
      type: 'payout.succeeded',
      idempotencyKey: 'po-wh-9',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ result: 'noop' });
    expect((await getPayoutRow(id)).status).toBe('failed');
    expect(await accountBalance(source)).toBe(100000n);
  });

  it('returns 503 when no webhook secret is configured', async () => {
    const prev = process.env['WEBHOOK_SECRET'];
    delete process.env['WEBHOOK_SECRET'];
    const { resetEnvCache } = await import('../../src/config/env.js');
    resetEnvCache();
    try {
      const res = await postWebhook(stack.app, {
        eventId: 'evt-wh-10',
        type: 'payout.succeeded',
        idempotencyKey: 'x',
      });
      expect(res.statusCode).toBe(503);
    } finally {
      process.env['WEBHOOK_SECRET'] = prev;
      resetEnvCache();
    }
  });
});
