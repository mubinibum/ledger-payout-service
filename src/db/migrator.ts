import { Migrator, type Kysely, type MigrationProvider } from 'kysely';
import type { Database } from './schema.js';
import { migrations } from './migrations/index.js';

/**
 * A static in-memory migration provider. Migrations are explicit imports (see
 * `migrations/index.ts`) rather than a filesystem glob, so the set is identical whether
 * the code runs under `tsx` (dev) or from the compiled `dist/` build.
 */
class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): ReturnType<MigrationProvider['getMigrations']> {
    return migrations;
  }
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });
}
