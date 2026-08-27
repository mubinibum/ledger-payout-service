import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { loadEnv } from '../config/env.js';

/**
 * Database schema types. Deliberately empty in M1 — no tables are defined yet. Later
 * milestones add interfaces here (accounts, ledger_entry, transaction, payout,
 * webhook_event, outbox, idempotency) alongside their migrations.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

let pool: Pool | undefined;
let db: Kysely<Database> | undefined;

function getPool(): Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    max: 10,
    connectionTimeoutMillis: env.READINESS_TIMEOUT_MS,
  });
  return pool;
}

/** Lazily-created Kysely instance. Connecting is deferred until the first query. */
export function getDb(): Kysely<Database> {
  if (db) return db;
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: getPool() }) });
  return db;
}

/** Cheap liveness probe for /readyz. Returns true if a trivial query succeeds in time. */
export async function pingDb(timeoutMs: number): Promise<boolean> {
  try {
    const result = await Promise.race([
      getPool().query<{ ok: number }>('select 1 as ok'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('db ping timeout')), timeoutMs),
      ),
    ]);
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = undefined;
    pool = undefined;
    return;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
