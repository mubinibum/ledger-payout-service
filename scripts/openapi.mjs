#!/usr/bin/env tsx
/**
 * OpenAPI source-of-truth tooling.
 *
 *   tsx scripts/openapi.mjs generate   → (re)write openapi/openapi.json from the YAML
 *   tsx scripts/openapi.mjs check      → validate the spec AND fail on drift vs the app
 *
 * The YAML (`openapi/openapi.yaml`) is hand-maintained; the JSON is a deterministic
 * derivative committed alongside it so tools that want JSON need no build step. `check`
 * fails if the JSON is stale, if the spec is structurally invalid, or if the set of
 * documented `METHOD path` pairs differs from what `buildApp` actually registers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = process.cwd();
const YAML_PATH = join(ROOT, 'openapi', 'openapi.yaml');
const JSON_PATH = join(ROOT, 'openapi', 'openapi.json');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const COMPARABLE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_PATH_FRAGMENTS = ['mock-provider', 'fault', '/admin', 'manual-review', '/internal'];

const loadSpec = () => parse(readFileSync(YAML_PATH, 'utf8'));
const serialize = (spec) => `${JSON.stringify(spec, null, 2)}\n`;

function validateStructure(spec) {
  const errs = [];
  if (spec.openapi !== '3.1.0')
    errs.push(`openapi must be "3.1.0" (got ${spec.openapi ?? 'nothing'})`);
  if (!spec.info?.title) errs.push('info.title is required');
  if (!spec.info?.version) errs.push('info.version is required');
  if (!spec.paths || typeof spec.paths !== 'object') errs.push('paths object is required');

  const operationIds = new Set();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith('/')) errs.push(`path "${path}" must start with "/"`);
    for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
      if (path.includes(fragment)) {
        errs.push(
          `path "${path}" looks like an internal control endpoint (contains "${fragment}")`,
        );
      }
    }
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) errs.push(`${label}: missing operationId`);
      else if (operationIds.has(op.operationId))
        errs.push(`duplicate operationId "${op.operationId}"`);
      else operationIds.add(op.operationId);
      if (!op.responses || Object.keys(op.responses).length === 0)
        errs.push(`${label}: no responses`);
    }
  }

  // The dev/demo funding endpoint must be flagged so nobody mistakes it for a real feature.
  const funding = spec.paths?.['/v1/accounts/{id}/funding']?.post;
  if (!funding) errs.push('expected POST /v1/accounts/{id}/funding to be documented');
  else if (funding['x-dev-only'] !== true)
    errs.push('POST /v1/accounts/{id}/funding must carry x-dev-only: true');

  // Every local $ref must resolve; external refs are not allowed.
  const refs = [];
  (function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else collect(v);
      }
    }
  })(spec);
  for (const ref of refs) {
    if (!ref.startsWith('#/')) {
      errs.push(`external $ref is not allowed: ${ref}`);
      continue;
    }
    const parts = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = spec;
    for (const part of parts) cur = cur?.[part];
    if (cur === undefined) errs.push(`dangling $ref: ${ref}`);
  }
  return errs;
}

/** `METHOD path` pairs the spec documents (HEAD/OPTIONS ignored, `{x}` → `:x`). */
function documentedRoutes(spec) {
  const out = new Set();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const fastifyPath = path.replace(/\{([^}]+)\}/g, ':$1');
    for (const method of HTTP_METHODS) {
      if (!item[method]) continue;
      const upper = method.toUpperCase();
      if (COMPARABLE_METHODS.has(upper)) out.add(`${upper} ${fastifyPath}`);
    }
  }
  return out;
}

/** `METHOD path` pairs the app actually registers. */
async function registeredRoutes() {
  process.env.NODE_ENV ??= 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.PGPORT ??= '59999';
  process.env.REDIS_PORT ??= '59998';
  process.env.WEBHOOK_SECRET ??= 'openapi-check-secret-0123456789';
  process.env.METRICS_ENABLED = 'true'; // document /metrics as a real route
  const { buildApp } = await import('../src/app.ts');
  const out = new Set();
  const app = await buildApp(undefined, {
    onRoute: (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        if (COMPARABLE_METHODS.has(m.toUpperCase())) out.add(`${m.toUpperCase()} ${r.url}`);
      }
    },
  });
  await app.ready();
  await app.close();
  return out;
}

async function main() {
  const mode = process.argv[2];
  const spec = loadSpec();

  if (mode === 'generate') {
    writeFileSync(JSON_PATH, serialize(spec));
    console.log(`openapi/openapi.json regenerated (${Object.keys(spec.paths).length} paths).`);
    return;
  }

  if (mode !== 'check') {
    console.error('usage: tsx scripts/openapi.mjs <generate|check>');
    process.exit(2);
  }

  const problems = validateStructure(spec);

  let onDiskJson = '';
  try {
    onDiskJson = readFileSync(JSON_PATH, 'utf8');
  } catch {
    problems.push('openapi/openapi.json is missing — run `npm run openapi:generate`');
  }
  if (onDiskJson && onDiskJson !== serialize(spec)) {
    problems.push('openapi/openapi.json is stale — run `npm run openapi:generate` and commit it');
  }

  const documented = documentedRoutes(spec);
  const registered = await registeredRoutes();
  for (const route of documented) {
    if (!registered.has(route)) problems.push(`phantom route in spec (not registered): ${route}`);
  }
  for (const route of registered) {
    if (!documented.has(route))
      problems.push(`undocumented route (registered, not in spec): ${route}`);
  }

  if (problems.length > 0) {
    console.error('OpenAPI check FAILED:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `OpenAPI check passed — ${documented.size} documented operations match the registered routes.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
