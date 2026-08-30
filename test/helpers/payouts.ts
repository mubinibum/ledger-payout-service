import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { Queue } from 'bullmq';
import { bullConnection } from '../../src/infra/queue.js';
import { loadEnv } from '../../src/config/env.js';
import type { LedgerTransactionType } from '../../src/db/schema.js';
import { testDb } from './pg.js';
import type { PayoutRow } from '../../src/modules/payouts/payouts.repository.js';

export interface PayoutResponse {
  id: string;
  externalId: string;
  status: string;
  amountMinor: string;
  currency: string;
  reservationLedgerTransactionId: string;
  settlementLedgerTransactionId: string | null;
  releaseLedgerTransactionId: string | null;
}

export async function createPayoutHttp(
  app: FastifyInstance,
  input: {
    sourceAccountId: string;
    amount: string | number;
    currency?: string;
    externalId?: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    sourceAccountId: input.sourceAccountId,
    amount: input.amount,
    currency: input.currency ?? 'USD',
  };
  if (input.externalId) payload['externalId'] = input.externalId;
  if (input.metadata) payload['metadata'] = input.metadata;

  const res = await app.inject({
    method: 'POST',
    url: '/v1/payouts',
    headers: { 'idempotency-key': input.idempotencyKey ?? `pk_${randomUUID()}` },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

export async function getPayoutRow(id: string): Promise<PayoutRow> {
  const row = await testDb()
    .selectFrom('payouts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new Error(`payout ${id} not found`);
  return row;
}

export async function accountBalance(id: string): Promise<bigint> {
  const row = await testDb()
    .selectFrom('accounts')
    .select('balance_minor')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.balance_minor;
}

export async function systemBalance(purpose: string, currency = 'USD'): Promise<bigint> {
  const row = await testDb()
    .selectFrom('accounts')
    .select('balance_minor')
    .where('external_id', '=', `system:${purpose}:${currency}`)
    .executeTakeFirstOrThrow();
  return row.balance_minor;
}

export async function totalSystemValue(): Promise<bigint> {
  const rows = await testDb().selectFrom('accounts').select('balance_minor').execute();
  return rows.reduce((acc, r) => acc + r.balance_minor, 0n);
}

export async function countLedgerByType(type: LedgerTransactionType): Promise<number> {
  const row = await testDb()
    .selectFrom('ledger_transactions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('type', '=', type)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function assertAllLedgerBalanced(): Promise<void> {
  const rows = await sql<{ id: string; entry_count: string; net: string }>`
    SELECT ledger_transaction_id AS id,
           count(*) AS entry_count,
           COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS net
      FROM ledger_entries GROUP BY ledger_transaction_id
  `.execute(testDb());
  for (const r of rows.rows) {
    if (Number(r.entry_count) < 2) throw new Error(`txn ${r.id} has ${r.entry_count} entries`);
    if (BigInt(r.net) !== 0n) throw new Error(`txn ${r.id} unbalanced (net ${r.net})`);
  }
}

/** A fresh BullMQ queue handle for the test's queue name; caller must `close()`. */
export function testQueue(): Queue {
  return new Queue(loadEnv().PAYOUT_QUEUE_NAME, { connection: bullConnection() });
}

export async function drainQueue(): Promise<void> {
  const q = testQueue();
  try {
    await q.obliterate({ force: true });
  } finally {
    await q.close();
  }
}

export function expectPayout(body: Record<string, unknown>): PayoutResponse {
  expect(body).toHaveProperty('payout');
  return (body as { payout: PayoutResponse }).payout;
}
