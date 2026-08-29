import { beforeAll } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';

/**
 * Per-file test environment. Unit tests run with no services (dependency probes fail fast,
 * readiness → "degraded"). Integration tests inherit `DATABASE_URL` from
 * `test/global-setup.ts`, which takes precedence over the PG* fields below.
 */
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['READINESS_TIMEOUT_MS'] = '1000';
  if (!process.env['DATABASE_URL']) {
    // No container: point dependencies at closed ports so probes fail immediately.
    process.env['PGPORT'] = '59999';
    process.env['REDIS_PORT'] = '59998';
  }
  resetEnvCache();
});
