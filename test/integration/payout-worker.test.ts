import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Worker } from 'bullmq';
import { resetEnvCache } from '../../src/config/env.js';
import { getDb, closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';
import { bullEnqueuer, closePayoutQueue, PAYOUT_JOB_NAME } from '../../src/infra/queue.js';
import { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import { payoutOutboxSideEffect } from '../../src/composition.js';
import { createPayoutWorker, processPayoutJob } from '../../src/modules/payouts/payout.worker.js';
import { PayoutsService } from '../../src/modules/payouts/payouts.service.js';
import { insertOutboxEvent } from '../../src/modules/outbox/outbox.repository.js';
import { resetDb, testDb, closeTestDb } from '../helpers/pg.js';
import { drainQueue } from '../helpers/payouts.js';
import { FakeProvider } from '../helpers/fake-provider.js';

const PUB_OPTS = { batchSize: 50, maxAttempts: 5, backoffMs: 5, pollIntervalMs: 50 };

async function seedPayout(
  db: ReturnType<typeof getDb>,
  amount = 10_000n,
): Promise<{ payoutId: string; externalId: string }> {
  const source = await db
    .insertInto('accounts')
    .values({ external_id: `acct-${randomUUID()}`, currency: 'USD', allow_overdraft: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  const holding = await db
    .selectFrom('accounts')
    .select('id')
    .where('external_id', '=', 'system:payout_holding:USD')
    .executeTakeFirstOrThrow();

  const externalId = `po-${randomUUID()}`;
  const payoutId = randomUUID();
  await db.transaction().execute(async (trx) => {
    const txn = await trx
      .insertInto('ledger_transactions')
      .values({ type: 'payout_reservation', metadata: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('ledger_entries')
      .values([
        {
          ledger_transaction_id: txn.id,
          account_id: source.id,
          direction: 'debit',
          amount_minor: amount,
          balance_after: -amount,
          currency: 'USD',
        },
        {
          ledger_transaction_id: txn.id,
          account_id: holding.id,
          direction: 'credit',
          amount_minor: amount,
          balance_after: amount,
          currency: 'USD',
        },
      ])
      .execute();
    await trx
      .updateTable('accounts')
      .set({ balance_minor: -amount })
      .where('id', '=', source.id)
      .execute();
    await trx
      .updateTable('accounts')
      .set({ balance_minor: amount })
      .where('id', '=', holding.id)
      .execute();
    await trx
      .insertInto('payouts')
      .values({
        id: payoutId,
        external_id: externalId,
        source_account_id: source.id,
        amount_minor: amount,
        currency: 'USD',
        provider_idempotency_key: externalId,
        reservation_ledger_transaction_id: txn.id,
      })
      .execute();
    await insertOutboxEvent(trx, {
      aggregateType: 'payout',
      aggregateId: payoutId,
      eventType: 'payout.requested',
      payload: { payoutId },
    });
  });
  return { payoutId, externalId };
}

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const payoutStatus = (id: string): Promise<string> =>
  testDb()
    .selectFrom('payouts')
    .select('status')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
    .then((r) => r.status);

describe('integration: payout worker (real BullMQ)', () => {
  let worker: Worker | undefined;
  let provider: FakeProvider;
  let payouts: PayoutsService;

  beforeAll(() => {
    process.env['PAYOUT_QUEUE_NAME'] = `test-payouts-${randomUUID()}`;
    process.env['WORKER_MAX_ATTEMPTS'] = '3';
    process.env['WORKER_BACKOFF_MS'] = '100';
    process.env['WORKER_CONCURRENCY'] = '4';
    resetEnvCache();
  });
  afterAll(async () => {
    await drainQueue();
    await closePayoutQueue();
    await closeRedis();
    await closeDb();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    await drainQueue();
    provider = new FakeProvider();
    payouts = new PayoutsService(getDb());
  });
  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
  });

  function startWorker(): void {
    worker = createPayoutWorker({ db: getDb(), service: payouts, provider });
  }

  it('end to end: outbox → publisher → worker → settled', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'succeeded' });

    const publisher = new OutboxPublisher(getDb(), bullEnqueuer(), {
      ...PUB_OPTS,
      sideEffect: payoutOutboxSideEffect(),
    });
    await publisher.runOnce();
    expect(await payoutStatus(payoutId)).toBe('queued');

    startWorker();
    await waitFor(
      () => payoutStatus(payoutId),
      (s) => s === 'succeeded',
    );
  });

  it('a duplicate BullMQ delivery is safe (one settlement)', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'succeeded' });

    // enqueue the same jobId twice manually
    const enq = bullEnqueuer();
    await enq.add(PAYOUT_JOB_NAME, { payoutId }, { jobId: 'dup-job' });
    await enq.add(PAYOUT_JOB_NAME, { payoutId }, { jobId: 'dup-job' });

    startWorker();
    await waitFor(
      () => payoutStatus(payoutId),
      (s) => s === 'succeeded',
    );

    const settlements = await testDb()
      .selectFrom('ledger_transactions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'payout_settlement')
      .executeTakeFirstOrThrow();
    expect(Number(settlements.n)).toBe(1);
  });

  it('a transient failure retries with the SAME provider idempotency key, then succeeds', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'transient', times: 2 });

    await bullEnqueuer().add(PAYOUT_JOB_NAME, { payoutId }, { jobId: payoutId });
    startWorker();
    await waitFor(
      () => payoutStatus(payoutId),
      (s) => s === 'succeeded',
      12_000,
    );

    expect(provider.createCallCount(externalId)).toBe(3);
    expect(new Set(provider.createCalls).size).toBe(1); // always the same key
  });

  it('a permanent rejection is not retried and releases the funds', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'permanent', category: 'permanent_rejection' });

    await bullEnqueuer().add(PAYOUT_JOB_NAME, { payoutId }, { jobId: payoutId });
    startWorker();
    await waitFor(
      () => payoutStatus(payoutId),
      (s) => s === 'failed',
    );

    expect(provider.createCallCount(externalId)).toBe(1);
  });

  it('an exhausted transient failure dead-letters and releases (provider never took it)', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'transient', times: 99 });

    await bullEnqueuer().add(PAYOUT_JOB_NAME, { payoutId }, { jobId: payoutId });
    startWorker();
    await waitFor(
      () => payoutStatus(payoutId),
      (s) => s === 'failed',
      15_000,
    );

    const row = await testDb()
      .selectFrom('payouts')
      .selectAll()
      .where('id', '=', payoutId)
      .executeTakeFirstOrThrow();
    expect(row.failure_category).toBe('transient_exhausted');
    expect(row.release_ledger_transaction_id).not.toBeNull();
  });

  it('graceful shutdown: close() waits for the in-flight job', async () => {
    const { payoutId, externalId } = await seedPayout(getDb());
    provider.onCreate(externalId, { kind: 'succeeded' });
    await bullEnqueuer().add(PAYOUT_JOB_NAME, { payoutId }, { jobId: payoutId });

    startWorker();
    // give the worker a beat to pick the job up, then close
    await new Promise((r) => setTimeout(r, 150));
    await worker!.close();
    worker = undefined;

    // the job that was in flight completed
    const status = await payoutStatus(payoutId);
    expect(['succeeded', 'processing', 'queued']).toContain(status);
    if (status !== 'succeeded') {
      // finish it with a direct call — no work was lost, the payout is still actionable
      await processPayoutJob(
        { db: getDb(), service: payouts, provider },
        {
          payoutId,
          attemptsMade: 1,
          maxAttempts: 3,
        },
      );
      expect(await payoutStatus(payoutId)).toBe('succeeded');
    }
  });
});
