import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/schema.js';
import { metrics } from './metrics.js';

/**
 * Any object able to run a query — the root `Kysely` instance or an open `Transaction`.
 * Repositories take this so the same method works inside or outside a transaction.
 * (`Transaction<DB>` is assignable to `Kysely<DB>`, so this alias is really just intent.)
 */
export type Executor = Kysely<Database> | Transaction<Database>;

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/** True for transient DB faults where re-running the whole transaction is the right fix. */
export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

export interface RunInTransactionOptions {
  maxRetries: number;
}

/**
 * Runs `fn` inside a single database transaction (READ COMMITTED — the PostgreSQL
 * default). On a serialization failure or deadlock the whole transaction is retried up to
 * `maxRetries` times with a small randomised backoff. Deadlocks are already made unlikely
 * by deterministic lock ordering in the transfer path; this is the backstop.
 */
export async function runInTransaction<T>(
  db: Kysely<Database>,
  { maxRetries }: RunInTransactionOptions,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await db.transaction().execute(fn);
    } catch (err) {
      if (attempt < maxRetries && isTransientDbError(err)) {
        attempt += 1;
        metrics.transferRetryTotal.inc();
        await sleep(5 + Math.floor(Math.random() * 20));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
