import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = parse(readFileSync(`${root}openapi/openapi.yaml`, 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, { operationId?: string; responses?: unknown }>>;
};
const specJson = readFileSync(`${root}openapi/openapi.json`, 'utf8');

const HTTP = ['get', 'post', 'put', 'patch', 'delete'];
const toPairs = (fromSpec: boolean): Set<string> => {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    const p = fromSpec ? path.replace(/\{([^}]+)\}/g, ':$1') : path;
    for (const m of HTTP) if (item[m]) out.add(`${m.toUpperCase()} ${p}`);
  }
  return out;
};

describe('unit: OpenAPI spec', () => {
  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('every operation has an operationId and responses', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const m of HTTP) {
        const op = item[m];
        if (!op) continue;
        expect(op.operationId, `${m} ${path} operationId`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${m} ${path} responses`).toBeGreaterThan(0);
      }
    }
  });

  it('openapi/openapi.json is in sync with the YAML (run `npm run openapi:generate`)', () => {
    expect(specJson).toBe(`${JSON.stringify(spec, null, 2)}\n`);
  });

  it('does not document any internal control endpoint', () => {
    for (const path of Object.keys(spec.paths)) {
      expect(path).not.toMatch(/mock-provider|fault|\/admin|manual-review|\/internal/);
    }
  });

  it('flags the dev/demo funding endpoint as x-dev-only', () => {
    const funding = spec.paths['/v1/accounts/{id}/funding']?.['post'] as
      { 'x-dev-only'?: boolean } | undefined;
    expect(funding?.['x-dev-only']).toBe(true);
  });
});

describe('unit: OpenAPI vs registered routes (no drift)', () => {
  let app: FastifyInstance;
  const registered = new Set<string>();

  beforeAll(async () => {
    process.env['METRICS_ENABLED'] = 'true';
    app = await buildApp(undefined, {
      onRoute: (r) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) {
          if (HTTP.includes(m.toLowerCase())) registered.add(`${m.toUpperCase()} ${r.url}`);
        }
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    delete process.env['METRICS_ENABLED'];
    await app.close();
    await closeDb();
    await closeRedis();
  });

  it('has no phantom routes (documented but not registered)', () => {
    const documented = toPairs(true);
    expect([...documented].filter((r) => !registered.has(r))).toEqual([]);
  });

  it('has no undocumented routes (registered but not in the spec)', () => {
    const documented = toPairs(true);
    expect([...registered].filter((r) => !documented.has(r))).toEqual([]);
  });
});
