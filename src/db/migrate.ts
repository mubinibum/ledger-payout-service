/* eslint-disable no-console */
import { getDb, closeDb } from '../infra/db.js';
import { createMigrator } from './migrator.js';

/**
 * Migration CLI. Usage:
 *   npm run migrate           # alias for `up`
 *   npm run migrate:up        # migrate to the latest migration
 *   npm run migrate:down      # roll back the most recent migration (dev only)
 *   npm run migrate:status    # list every migration and whether it has run
 *
 * Exit code is non-zero if any step fails, so it is safe to chain in scripts / CI.
 */
type Command = 'up' | 'down' | 'status';

function parseCommand(argv: readonly string[]): Command {
  const raw = argv[2] ?? 'up';
  if (raw === 'up' || raw === 'down' || raw === 'status') return raw;
  console.error(`unknown command: ${raw} (expected: up | down | status)`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  const db = getDb();
  const migrator = createMigrator(db);

  if (command === 'status') {
    const rows = await migrator.getMigrations();
    for (const row of rows) {
      const state = row.executedAt ? `applied ${row.executedAt.toISOString()}` : 'pending';
      console.log(`${row.name.padEnd(40)} ${state}`);
    }
    return;
  }

  const { error, results } =
    command === 'up' ? await migrator.migrateToLatest() : await migrator.migrateDown();

  for (const result of results ?? []) {
    const verb = result.direction === 'Up' ? 'applied' : 'reverted';
    if (result.status === 'Success') {
      console.log(`${verb} ${result.migrationName}`);
    } else if (result.status === 'Error') {
      console.error(`failed ${result.migrationName}`);
    }
  }

  if (error) {
    throw error instanceof Error ? error : new Error('migration failed');
  }
  if ((results ?? []).length === 0) {
    console.log(command === 'up' ? 'already up to date' : 'nothing to roll back');
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    void closeDb().finally(() => process.exit(1));
  });
