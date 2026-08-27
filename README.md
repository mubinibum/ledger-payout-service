# ledger-payout-service

A generic, from-scratch **double-entry ledger and payout service**. It is an engineering
demonstration — **not** a real financial service, and it moves **no real money**.

> **Milestone: M1 (skeleton).** Only project scaffolding, configuration, health/readiness,
> logging, a CI file, and a smoke test exist so far. The ledger, transfers, payouts,
> webhooks, and queue flows are **not** implemented yet — see [Roadmap](#roadmap).

---

## Problem

Teams that move value between internal accounts and pay out to external providers keep
re-solving the same hard parts: keeping balances correct under concurrency, making writes
and webhook handling idempotent, not losing work across a crash, and knowing (from data,
not guesswork) when the pipeline is unhealthy. This project builds a small, focused service
that gets those parts right and shows the reasoning.

## Scope

**In scope (target):** accounts with derived balances; double-entry transfers with an
idempotency key; a payout state machine driven by a worker calling a *mock* provider;
signed, idempotent inbound webhooks with retry + dead-letter; a reconciliation job; scoped
auth; OpenAPI docs; structured logs, Prometheus metrics, health/readiness; Docker + CI; one
demo deployment.

**Explicitly not in scope:** real payment-provider integration or real money; multi-currency
/ FX, tax, fees, KYC, fraud scoring; a UI; microservices sprawl (two deployables at most);
high-availability infrastructure. See [`docs/adr/`](docs/adr/) for the decisions behind this.

## Architecture direction

A **modular monolith** in TypeScript: one deployable HTTP service (Fastify) plus a worker
process, sharing a PostgreSQL database (via Kysely) and Redis (cache, idempotency store,
BullMQ). The ledger is append-only; balance is always a query. Cross-cutting reliability
patterns — idempotency keys, a transactional outbox, retry/backoff, dead-letter, a
centralized status resolver — are applied consistently rather than per-feature. Full detail
lands with each milestone; the shape is recorded in [`docs/adr/`](docs/adr/).

```
             ┌───────────────────────────────┐
 client ───▶ │  ledger-payout-service (HTTP)  │──┐ enqueue
             │  accounts · ledger · payouts   │  │
             │  webhooks · health             │  ▼
             └──────┬───────────────┬────────┘  ┌──────────────┐
             Postgres│         Redis │          │ payout-worker│
                     ▼               ▼          └──────┬───────┘
              (ledger, outbox,  (cache, idem,          │ HTTP
               payouts, ...)     BullMQ)               ▼
                                              ┌──────────────────┐
                                              │  mock-provider   │
                                              └──────────────────┘
```

## Local setup

Requirements: Node.js 20.11+ and Docker (for Postgres/Redis; not needed just to run tests).

```bash
npm install
cp .env.example .env            # placeholder values are fine for local dev

docker compose up -d            # starts Postgres + Redis on 127.0.0.1
npm run dev                     # starts the service on http://127.0.0.1:3000

curl localhost:3000/healthz     # liveness  -> 200
curl localhost:3000/readyz      # readiness -> 200 when Postgres + Redis are reachable
```

Quality gates (all run in CI):

```bash
npm run format:check
npm run lint
npm run typecheck
npm test                        # smoke test; needs no services
npm run build
npm run compose:config          # validates docker-compose.yml
```

Or everything at once: `npm run check`.

## Security disclaimer

This repository is a **demo**. It handles no real money, stores no real user data, and talks
to no real payment provider. Do not deploy it as anything else. No secrets are committed —
`.env` is gitignored and only `.env.example` (placeholders) is tracked. See
[`SECURITY.md`](SECURITY.md).

This project is **generic and independent**. It does not reproduce the schema, table names,
transaction formats, retry policies, provider integrations, or internal architecture of any
system the author has worked on professionally.

## Roadmap

| Milestone | Content |
|---|---|
| **M1 (done)** | Skeleton: TS strict, lint/format, env schema, Docker Compose, health/readiness, logging, CI file, smoke test, ADRs |
| M2 | Accounts + double-entry transfers + idempotency; concurrency invariant test |
| M3 | Payout state machine, transactional outbox, worker + mock provider |
| M4 | Signed webhooks, idempotent apply, retry/backoff, dead-letter |
| M5 | Reconciliation job, Prometheus metrics, runbook |
| M6 | Threat model, CI security scans, OpenAPI |
| M7 | Deploy to one managed host, public demo URL |

## Non-goals

Real money · real provider integrations · multi-currency / FX · tax / fees / KYC / fraud ·
a UI · more than two deployables · HA infrastructure · reproducing any proprietary system.

## License

[MIT](LICENSE)
