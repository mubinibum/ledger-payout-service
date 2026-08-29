import { defineConfig } from 'vitest/config';

/**
 * Fast unit-only subset — no Testcontainers, no Docker. Pure domain logic and in-process
 * HTTP wiring. Run with `npm run test:unit`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 15_000,
  },
});
