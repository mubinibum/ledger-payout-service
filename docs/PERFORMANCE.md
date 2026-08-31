# Performance — `LOCAL_BENCHMARK_ONLY`

> These numbers describe **one developer laptop** with PostgreSQL and Redis in local Docker,
> no network hop, no TLS, no other tenants. They are a smoke test for "does it fall over",
> not a capacity statement, and they are deliberately **not** in the résumé or the README
> headline.

## How to run

```sh
docker compose up -d
npm run migrate:up
ALLOW_FUNDING=true npm run dev          # in one terminal
npm run bench                            # in another
# or: BENCH_CONNECTIONS=32 BENCH_DURATION_MS=8000 npm run bench
```

`scripts/bench.mjs` provisions two accounts through the public API, (optionally) funds the
source, then drives four scenarios for a fixed duration with a fixed number of concurrent
callers, and writes a JSON report to `bench-results/`.

## Scenarios (measured separately)

| Scenario | What it exercises |
|---|---|
| `health` | `GET /healthz` — pure HTTP path, no DB |
| `account-read` | `GET /v1/accounts/:id` — one indexed point read + balance projection |
| `idempotent-transfer-replay` | `POST /v1/transfers` re-sending one already-used `Idempotency-Key` — the replay fast-path (stored response, no ledger write) |
| `contended-transfers` | `POST /v1/transfers` from a single source account with unique keys — row-lock contention on one account + balanced ledger write |

## What to report

For each scenario the report captures: environment (Node version, platform), connections,
duration, request count, throughput (req/s), latency p50 / p95 / p99 / max, and error count.
The `contended-transfers` scenario is the interesting one — it shows how the single-row lock
on the source account serialises writes and where latency grows under contention.

## Interpreting it

- `health` and `account-read` throughput is bounded by the event loop and the local DB
  round-trip; expect thousands of req/s.
- `idempotent-transfer-replay` should be close to `account-read` — it is a single indexed
  lookup and a serialise, no write.
- `contended-transfers` throughput is intentionally lower: correctness (no lost update, no
  negative balance) is enforced by serialising writes to the same account. This is the
  trade-off, and it is the point.

## A sample run (illustrative only)

Apple laptop, Node 20.20.2, PostgreSQL 16 + Redis 7 in local Docker, 24 concurrent
connections, 4 s per scenario, `NODE_ENV=production` (`node dist/index.js`):

| Scenario | Throughput | p50 | p95 | p99 | errors |
|---|--:|--:|--:|--:|--:|
| `health` | ~22,400 req/s | 0.9 ms | 2.2 ms | 3.1 ms | 0 |
| `account-read` | ~12,400 req/s | 1.7 ms | 3.4 ms | 4.9 ms | 0 |
| `idempotent-transfer-replay` | ~4,000 req/s | 5.6 ms | 9.2 ms | 11.7 ms | 0 |
| `contended-transfers` (one source account) | ~435 req/s | 54 ms | 63 ms | 74 ms | 0 |

The ~50× drop from replay to contended writes is the point: correctness (no lost update, no
negative balance) is bought by serialising writes to the same account row. Spread the load
across accounts and it scales; hammer one account and it queues. Re-run on your own machine
— absolute numbers will differ.

## Caveats (always attached to any figure)

- Single machine, single Postgres instance, single Redis instance, all local Docker.
- Run-to-run variance is significant; take a median of several runs.
- No production-representative data volume, no replication, no connection proxy.
- The worker / outbox / provider path is **not** in this benchmark — it is asynchronous and
  measured by the integration tests, not by throughput here.
