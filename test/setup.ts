import { beforeAll } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';

/**
 * Per-file test environment. Unit tests run with no services (dependency probes fail fast,
 * readiness → "degraded"). Integration tests inherit `DATABASE_URL` / `REDIS_URL` from
 * `test/global-setup.ts`, which take precedence over the PG and Redis fields below.
 */
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['READINESS_TIMEOUT_MS'] = '1000';
  // The funding endpoint is off by default; the test suite opts in explicitly. Individual
  // tests that assert the disabled behaviour flip it back off around themselves.
  process.env['ALLOW_FUNDING'] = 'true';
  process.env['WEBHOOK_SECRET'] = 'test-webhook-secret-0123456789';
  // Clear per-file M3 overrides so each file starts from schema defaults.
  for (const key of [
    'PAYOUT_QUEUE_NAME',
    'WORKER_MAX_ATTEMPTS',
    'WORKER_BACKOFF_MS',
    'WORKER_CONCURRENCY',
    'RECONCILE_STALE_AFTER_SEC',
    'RECONCILE_MAX_ATTEMPTS',
  ]) {
    delete process.env[key];
  }
  if (!process.env['DATABASE_URL']) {
    // No container: point dependencies at closed ports so probes fail immediately.
    process.env['PGPORT'] = '59999';
    process.env['REDIS_PORT'] = '59998';
  }
  resetEnvCache();
});
