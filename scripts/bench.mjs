#!/usr/bin/env tsx
/**
 * LOCAL_BENCHMARK_ONLY — a throughput/latency smoke test against a *running* local stack.
 *
 * These numbers describe one developer laptop with Docker-hosted PostgreSQL and Redis.
 * They are NOT a production capacity claim and are deliberately kept out of the résumé and
 * the public README's headline. See docs/PERFORMANCE.md.
 *
 * Prerequisites (all local):
 *   docker compose up -d
 *   npm run migrate:up
 *   ALLOW_FUNDING=true npm run dev         # money scenarios need funding enabled
 *
 * Usage:
 *   npm run bench
 *   BENCH_URL=http://127.0.0.1:3000 BENCH_DURATION_MS=5000 BENCH_CONNECTIONS=24 npm run bench
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:3000';
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 5000);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 20);
const CURRENCY = 'USD';

const pct = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function req(method, path, { body, idempotencyKey } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

async function runScenario(name, makeRequest) {
  const latencies = [];
  let ok = 0;
  let errors = 0;
  const deadline = performance.now() + DURATION_MS;

  async function worker() {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const { status } = await makeRequest();
        const elapsed = performance.now() - started;
        latencies.push(elapsed);
        if (status >= 200 && status < 300) ok += 1;
        else errors += 1;
      } catch {
        errors += 1;
      }
    }
  }

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  const wallSec = (performance.now() - wallStart) / 1000;
  latencies.sort((a, b) => a - b);
  const total = ok + errors;

  const result = {
    scenario: name,
    requests: total,
    ok,
    errors,
    throughputRps: Number((total / wallSec).toFixed(1)),
    latencyMs: {
      p50: Number(pct(latencies, 50).toFixed(2)),
      p95: Number(pct(latencies, 95).toFixed(2)),
      p99: Number(pct(latencies, 99).toFixed(2)),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
    },
  };
  console.log(
    `  ${name.padEnd(28)} ${String(result.throughputRps).padStart(8)} rps  ` +
      `p50=${result.latencyMs.p50}ms p95=${result.latencyMs.p95}ms p99=${result.latencyMs.p99}ms  ` +
      `errors=${errors}`,
  );
  return result;
}

async function main() {
  console.log(
    `LOCAL_BENCHMARK_ONLY — target ${BASE}, ${CONNECTIONS} connections, ${DURATION_MS}ms/scenario\n`,
  );

  const health = await req('GET', '/healthz');
  if (health.status !== 200) {
    console.error(`preflight failed: GET /healthz → ${health.status}. Start the stack first.`);
    process.exit(1);
  }
  const ready = await req('GET', '/readyz');
  if (ready.json?.status !== 'ok') {
    console.warn(`warning: /readyz is "${ready.json?.status}" — DB/Redis may be down.\n`);
  }

  // Provision two accounts.
  const src = await req('POST', '/v1/accounts', {
    body: { externalId: `bench-src-${randomUUID()}`, currency: CURRENCY },
  });
  const dst = await req('POST', '/v1/accounts', {
    body: { externalId: `bench-dst-${randomUUID()}`, currency: CURRENCY },
  });
  const sourceId = src.json?.account?.id;
  const destId = dst.json?.account?.id;
  if (!sourceId || !destId) {
    console.error('could not create bench accounts; aborting.');
    process.exit(1);
  }

  const funded = await req('POST', `/v1/accounts/${sourceId}/funding`, {
    body: { amount: '1000000000000', currency: CURRENCY },
    idempotencyKey: `bench-fund-${randomUUID()}`,
  });
  const moneyScenarios = funded.status === 201 || funded.status === 200;
  if (!moneyScenarios) {
    console.warn(
      `funding disabled (status ${funded.status}) — running read-only scenarios only. ` +
        'Start the service with ALLOW_FUNDING=true for the transfer scenarios.\n',
    );
  }

  const results = [];
  results.push(await runScenario('health', () => req('GET', '/healthz')));
  results.push(await runScenario('account-read', () => req('GET', `/v1/accounts/${sourceId}`)));

  if (moneyScenarios) {
    const replayKey = `bench-replay-${randomUUID()}`;
    const replayBody = {
      sourceAccountId: sourceId,
      destinationAccountId: destId,
      amount: '1',
      currency: CURRENCY,
    };
    await req('POST', '/v1/transfers', { body: replayBody, idempotencyKey: replayKey });
    results.push(
      await runScenario('idempotent-transfer-replay', () =>
        req('POST', '/v1/transfers', { body: replayBody, idempotencyKey: replayKey }),
      ),
    );

    results.push(
      await runScenario('contended-transfers', () =>
        req('POST', '/v1/transfers', {
          body: {
            sourceAccountId: sourceId,
            destinationAccountId: destId,
            amount: '1',
            currency: CURRENCY,
          },
          idempotencyKey: `bench-c-${randomUUID()}`,
        }),
      ),
    );
  }

  const report = {
    label: 'LOCAL_BENCHMARK_ONLY',
    generatedAt: new Date().toISOString(),
    target: BASE,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    connections: CONNECTIONS,
    durationMsPerScenario: DURATION_MS,
    moneyScenarios,
    results,
    caveats: [
      'Single developer machine; PostgreSQL and Redis in local Docker.',
      'Numbers vary run to run; not a production capacity figure.',
      'No network hop, no TLS, no other tenants.',
    ],
  };
  mkdirSync('bench-results', { recursive: true });
  const out = `bench-results/bench-${Date.now()}.json`;
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
