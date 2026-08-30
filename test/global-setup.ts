import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createMigrator } from '../src/db/migrator.js';
import type { Database } from '../src/db/schema.js';

/**
 * Starts one PostgreSQL container and one Redis container for the whole test run and
 * migrates the database from zero. `DATABASE_URL` and `REDIS_URL` are exported; Vitest
 * forks inherit them, so the app under test, the worker/publisher, and the test helpers
 * all talk to the same services.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const [pgc, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const uri = pgc.getConnectionUri();
  process.env['DATABASE_URL'] = uri;
  process.env['REDIS_URL'] = redis.getConnectionUrl();

  pg.types.setTypeParser(20, (value: string): bigint => BigInt(value));
  const pool = new pg.Pool({ connectionString: uri });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  try {
    const { error, results } = await createMigrator(db).migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('test migration failed');
    if (!results || results.length === 0) {
      throw new Error('no migrations were applied to the test database');
    }
  } finally {
    await db.destroy();
  }

  return async () => {
    await Promise.allSettled([pgc.stop(), redis.stop()]);
  };
}
