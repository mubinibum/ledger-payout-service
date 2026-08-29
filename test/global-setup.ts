import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createMigrator } from '../src/db/migrator.js';
import type { Database } from '../src/db/schema.js';

/**
 * Starts one PostgreSQL container for the whole test run and migrates it from zero.
 * The connection URI is exported as `DATABASE_URL`; Vitest forks inherit it, so both the
 * app under test (`getDb()`) and the test helpers talk to this same database.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  process.env['DATABASE_URL'] = uri;

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
    await container.stop();
  };
}
