import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { OutboxEventsTable } from '../../db/schema.js';
import type { Executor } from '../../infra/tx.js';

export type OutboxEventRow = Selectable<OutboxEventsTable>;

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

/** Written in the SAME transaction as the aggregate change it describes. */
export async function insertOutboxEvent(
  db: Executor,
  input: NewOutboxEvent,
): Promise<OutboxEventRow> {
  return db
    .insertInto('outbox_events')
    .values({
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      schema_version: input.schemaVersion ?? 1,
      payload: JSON.stringify(input.payload),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Claims up to `limit` due, un-published events for this worker using
 * `FOR UPDATE SKIP LOCKED` — several publisher instances can poll the same table without
 * ever handing the same row to two of them, and rows from uncommitted producers are
 * invisible.
 */
export async function claimPendingEvents(db: Executor, limit: number): Promise<OutboxEventRow[]> {
  return db
    .selectFrom('outbox_events')
    .selectAll()
    .where('status', '=', 'pending')
    .where('available_at', '<=', sql<Date>`now()`)
    .orderBy('available_at', 'asc')
    .orderBy('created_at', 'asc')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}

export async function markEventPublished(db: Executor, id: string): Promise<void> {
  await db
    .updateTable('outbox_events')
    .set({ status: 'published', published_at: sql<Date>`now()`, locked_at: null })
    .where('id', '=', id)
    .execute();
}

export async function markEventRetry(
  db: Executor,
  id: string,
  opts: { errorCategory: string; backoffMs: number; maxAttempts: number; currentAttempts: number },
): Promise<void> {
  const nextAttempts = opts.currentAttempts + 1;
  const dead = nextAttempts >= opts.maxAttempts;
  await db
    .updateTable('outbox_events')
    .set({
      attempt_count: nextAttempts,
      last_error: opts.errorCategory,
      status: dead ? 'dead' : 'pending',
      available_at: sql<Date>`now() + (${opts.backoffMs} || ' milliseconds')::interval`,
    })
    .where('id', '=', id)
    .execute();
}

export interface OutboxStats {
  pending: number;
  published: number;
  dead: number;
  oldestPendingAgeSeconds: number | null;
}

export async function outboxStats(db: Executor): Promise<OutboxStats> {
  const rows = await db
    .selectFrom('outbox_events')
    .select(['status'])
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .select((eb) => eb.fn.min('created_at').as('oldest'))
    .groupBy('status')
    .execute();

  const stats: OutboxStats = {
    pending: 0,
    published: 0,
    dead: 0,
    oldestPendingAgeSeconds: null,
  };
  for (const row of rows) {
    const n = Number(row.count);
    if (row.status === 'pending') {
      stats.pending = n;
      if (row.oldest) {
        stats.oldestPendingAgeSeconds = Math.round(
          (Date.now() - new Date(row.oldest).getTime()) / 1000,
        );
      }
    } else if (row.status === 'published') {
      stats.published = n;
    } else if (row.status === 'dead') {
      stats.dead = n;
    }
  }
  return stats;
}
