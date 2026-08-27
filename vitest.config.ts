import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 15_000,
    // Integration tests that need Postgres/Redis (via Testcontainers) are added in later
    // milestones and tagged; M1 ships only a fast smoke test that needs no services.
  },
});
