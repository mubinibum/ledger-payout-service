import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import type { Database } from '../db/schema.js';

export type { Database } from '../db/schema.js';

/**
 * Parse PostgreSQL `int8` (OID 20) as a JS `bigint` rather than the default `string`.
 * Money in this service is integer minor units, and `bigint` keeps it exact end to end.
 */
pg.types.setTypeParser(20, (value: string): bigint => BigInt(value));

const { Pool } = pg;

let pool: pg.Pool | undefined;
let db: Kysely<Database> | undefined;

function poolConfig(): pg.PoolConfig {
  const env = loadEnv();
  const base: pg.PoolConfig = {
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  };
  if (env.DATABASE_URL) {
    return { ...base, connectionString: env.DATABASE_URL };
  }
  return {
    ...base,
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
  };
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool(poolConfig());
  // Keep a stray idle-client error from crashing the process.
  pool.on('error', () => undefined);
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
