import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../../src/infra/db.js';
import { resetEnvCache } from '../../src/config/env.js';
import { clearFaults, armFault } from '../../src/infra/fault.js';
import { OutboxPublisher } from '../../src/modules/outbox/outbox.publisher.js';
import { insertOutboxEvent } from '../../src/modules/outbox/outbox.repository.js';
import type { JobEnqueuer } from '../../src/infra/queue.js';
import { resetDb, testDb, closeTestDb } from '../helpers/pg.js';

class RecordingEnqueuer implements JobEnqueuer {
  calls: { jobId: string; data: Record<string, unknown> }[] = [];
  failFor = new Set<string>();
  async add(_name: string, data: Record<string, unknown>, opts: { jobId: string }): Promise<void> {
    if (this.failFor.has(opts.jobId))
      throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
    this.calls.push({ jobId: opts.jobId, data });
  }
}

const OPTS = {
  batchSize: 50,
  maxAttempts: 3,
  backoffMs: 10,
  pollIntervalMs: 50,
  enqueueTimeoutMs: 2000,
};

async function seedEvents(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = await insertOutboxEvent(testDb(), {
      aggregateType: 'payout',
      aggregateId: randomUUID(),
      eventType: 'payout.requested',
      payload: { payoutId: randomUUID(), i },
    });
    ids.push(row.id);
  }
  return ids;
}

describe('integration: transactional outbox publisher', () => {
  beforeAll(() => {
    resetEnvCache();
  });
  afterAll(async () => {
    clearFaults();
    await closeDb();
    await closeTestDb();
  });
  beforeEach(async () => {
    clearFaults();
    await resetDb();
  });

  it('publishes each pending event once, with the event id as the job id', async () => {
    const ids = await seedEvents(5);
    const enq = new RecordingEnqueuer();
    const publisher = new OutboxPublisher(getDb(), enq, OPTS);

    const r = await publisher.runOnce();
    expect(r).toEqual({ published: 5, retried: 0 });
    expect(enq.calls.map((c) => c.jobId).sort()).toEqual([...ids].sort());

    const rows = await testDb().selectFrom('outbox_events').select(['status']).execute();
    expect(rows.every((row) => row.status === 'published')).toBe(true);

    // a second cycle does nothing
    expect(await publisher.runOnce()).toEqual({ published: 0, retried: 0 });
  });

  it('two publishers running in parallel never enqueue the same event twice', async () => {
    await seedEvents(40);
    const enq = new RecordingEnqueuer();
    const p1 = new OutboxPublisher(getDb(), enq, OPTS);
    const p2 = new OutboxPublisher(getDb(), enq, OPTS);

    const [a, b] = await Promise.all([p1.runOnce(), p2.runOnce()]);
    expect(a.published + b.published).toBe(40);

    const jobIds = enq.calls.map((c) => c.jobId);
    expect(new Set(jobIds).size).toBe(40);
    const pending = await testDb()
      .selectFrom('outbox_events')
      .select('id')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(0);
  });

  it('an enqueue failure marks the event for retry, not published', async () => {
    const [id] = await seedEvents(1);
    const enq = new RecordingEnqueuer();
    enq.failFor.add(id!);
    const publisher = new OutboxPublisher(getDb(), enq, OPTS);

    const r = await publisher.runOnce();
    expect(r).toEqual({ published: 0, retried: 1 });

    const row = await testDb()
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id!)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toBe('redis_unavailable');
  });

  it('exhausting retries moves the event to dead', async () => {
    const [id] = await seedEvents(1);
    const enq = new RecordingEnqueuer();
    enq.failFor.add(id!);
    const publisher = new OutboxPublisher(getDb(), enq, { ...OPTS, maxAttempts: 2, backoffMs: 0 });

    await publisher.runOnce();
    await publisher.runOnce();

    const row = await testDb()
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id!)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('dead');
  });

  it('a crash after enqueue but before mark-published leaves the event pending (re-published next cycle)', async () => {
    const ids = await seedEvents(3);
    const enq = new RecordingEnqueuer();
    const publisher = new OutboxPublisher(getDb(), enq, OPTS);

    armFault('after_enqueue_before_outbox_update');
    await expect(publisher.runOnce()).rejects.toThrow(/injected fault/);

    // Redis got at least one enqueue, but nothing was committed as published.
    expect(enq.calls.length).toBeGreaterThanOrEqual(1);
    const published = await testDb()
      .selectFrom('outbox_events')
      .select('id')
      .where('status', '=', 'published')
      .execute();
    expect(published).toHaveLength(0);

    // Next cycle re-publishes; job ids are stable so BullMQ would dedupe.
    clearFaults();
    const r = await publisher.runOnce();
    expect(r.published).toBe(3);
    const jobIds = enq.calls.map((c) => c.jobId);
    // every event id appears, some possibly twice — deterministic jobId makes that safe
    for (const id of ids) expect(jobIds).toContain(id);
  });

  it('a hung Redis: runOnce returns within the enqueue timeout, the event is retried, and no lock is stuck', async () => {
    const [id] = await seedEvents(1);
    // an enqueuer that never resolves
    const hung: JobEnqueuer = { add: () => new Promise<void>(() => undefined) };
    const publisher = new OutboxPublisher(getDb(), hung, OPTS);

    const started = Date.now();
    const result = await publisher.runOnce(); // OUTBOX_ENQUEUE_TIMEOUT_MS default 3s
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(result).toEqual({ published: 0, retried: 1 });

    const row = await testDb()
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', id!)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('enqueue_timeout');

    // the row lock is released — a normal cycle recovers immediately
    const enq = new RecordingEnqueuer();
    const recovered = await new OutboxPublisher(getDb(), enq, OPTS).runOnce();
    expect(recovered.published).toBe(1);
  }, 20_000);
});
