import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../../src/config/env.js';
import { armFault, clearFaults, maybeFault } from '../../src/infra/fault.js';

type Env = Record<string, string>;

const base: Env = {
  NODE_ENV: 'production',
  WEBHOOK_SECRET: 'a-sufficiently-long-webhook-secret',
  DATABASE_URL: 'postgres://user:pass@db.example.com:5432/ledger',
  REDIS_URL: 'redis://redis.example.com:6379',
};

const without = (keys: string[], extra: Env = {}): Env => {
  const out: Env = { ...base, ...extra };
  for (const k of keys) delete out[k];
  return out;
};

describe('unit: production fail-closed config (env.superRefine)', () => {
  afterEach(() => resetEnvCache());

  it('accepts a well-formed production config', () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base })).not.toThrow();
  });

  it('refuses to start in production without WEBHOOK_SECRET', () => {
    resetEnvCache();
    expect(() => loadEnv(without(['WEBHOOK_SECRET']))).toThrow(/WEBHOOK_SECRET/);
  });

  it('refuses to start in production with ALLOW_FUNDING=true', () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base, ALLOW_FUNDING: 'true' })).toThrow(/ALLOW_FUNDING/);
  });

  it('refuses the placeholder DB password in production (no DATABASE_URL)', () => {
    resetEnvCache();
    expect(() => loadEnv(without(['DATABASE_URL'], { PGPASSWORD: 'change-me-locally' }))).toThrow(
      /PGPASSWORD/,
    );
  });

  it('leaves development untouched (defaults are fine)', () => {
    resetEnvCache();
    expect(() => loadEnv({ NODE_ENV: 'development' })).not.toThrow();
  });
});

describe('unit: fault injection is inert in production', () => {
  afterEach(() => {
    clearFaults();
    resetEnvCache();
  });

  it('armFault is a no-op when NODE_ENV=production', () => {
    resetEnvCache();
    loadEnv({ ...base });
    armFault('after_payout_insert');
    expect(() => maybeFault('after_payout_insert')).not.toThrow();
  });

  it('armFault works outside production (so tests can use it)', () => {
    resetEnvCache();
    loadEnv({ NODE_ENV: 'test' });
    armFault('after_payout_insert');
    expect(() => maybeFault('after_payout_insert')).toThrow();
  });
});
