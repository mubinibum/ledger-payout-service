import { defineConfig } from 'vitest/config';

/**
 * Full suite: unit + integration + concurrency. Integration tests need PostgreSQL, which
 * `test/global-setup.ts` provides via Testcontainers (one container for the whole run).
 * A single fork keeps DB-touching tests strictly sequential against that shared database.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
