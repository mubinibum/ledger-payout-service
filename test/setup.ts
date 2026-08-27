import { beforeAll } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';

/**
 * M1 tests run without Postgres or Redis. We pin a deterministic test environment so
 * `loadEnv()` succeeds and dependency probes fail fast (readiness → "degraded"), which
 * is exactly what we assert.
 */
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['READINESS_TIMEOUT_MS'] = '300';
  // Point dependencies at a closed port so probes fail immediately.
  process.env['PGPORT'] = '59999';
  process.env['REDIS_PORT'] = '59998';
  resetEnvCache();
});
